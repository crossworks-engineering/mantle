/**
 * The actor check's cost in database round trips (workspaces arch A2a, the
 * owner's rule: with the check off, 0 new queries and 0 new round trips).
 *
 * Every connection the brain opens (the system pool and the scoped pools)
 * goes through a TCP proxy that reads the Postgres wire: each statement the
 * client sends (Parse or Query), and each round trip: any send after the
 * server last answered on that connection. With prepare off, postgres.js
 * sends a statement with parameters in two steps (Parse and Describe, then
 * Bind and Execute), so it is two round trips. Seven paths run through the
 * real app or the real runtime: tree load, item open, search, chat turn
 * start, MCP tool call, page save (an Admin user's: the system pool), and a
 * member's page save, a login write the gateway sends to the write role in
 * warn and on (A2b2b fix round 1: measured in off, warn and on; its
 * statements on the write role's connections are counted apart).
 *
 * Pinned, within the build (fix round 2: no hard-coded counts):
 *  - with the check off, no statement sets or reads the actor: the setting,
 *    and the actor's own statements, tagged `/* mantle:actor *\/` (the mode
 *    read, loginActorNow, the Telegram and heartbeat lookups, the write
 *    wrapper's RESET);
 *  - in warn, the only added statements are the actor's own;
 *  - in warn, the same number of round trips as off, apart from the round
 *    trips that send only the actor's own statements (a lookup, the
 *    wrapper's RESET): the SET goes in the same send as a transaction's
 *    first statement, and the wrapper's session SET with its write;
 *  - in warn, no round trip carries the SET without a statement of the
 *    path's own: counted apart (setRoundTrips), always 0 (A2b);
 *  - a write outside a transaction ends with a RESET sent after the caller
 *    has its answer (resetRoundTrips): page save, which looks nothing up,
 *    takes off's round trips apart from those (A2b1 audit, Q1).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a2a-round-trips.db.test.ts
 * MANTLE_RT_REPORT=1 prints the table. MANTLE_RT_BASELINE=1 also compares
 * off with the counts at fe884e7c2 (OFF_BASELINE): the A2a merge gate only.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { teamWorkspaceSql } from '@mantle/db/test-support';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;
const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));

vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async () => 'sk-test'),
}));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
}));

type Path =
  | 'tree load'
  | 'item open'
  | 'search'
  | 'chat turn start'
  | 'MCP tool call'
  | 'page save'
  | 'member page save';
type Count = { statements: number; roundTrips: number };

/**
 * The counts at fe884e7c2 (before A2a), check off, measured with this file
 * on that commit. Checked only with MANTLE_RT_BASELINE=1 (the A2a merge
 * gate): a later feature that adds a query to one of these paths changes
 * them, so they are no rule for every build.
 */
const OFF_BASELINE: Partial<Record<Path, Count>> = {
  'tree load': { statements: 13, roundTrips: 17 },
  'item open': { statements: 9, roundTrips: 12 },
  search: { statements: 16, roundTrips: 22 },
  'chat turn start': { statements: 91, roundTrips: 133 },
  'MCP tool call': { statements: 37, roundTrips: 49 },
  'page save': { statements: 11, roundTrips: 17 },
};

/** The actor's own statements: its setting (packages/db/src/client.ts) and
 *  its tagged statements. */
const ACTOR_SQL = /mantle\.actor|mantle_actor_|\/\* mantle:actor \*\//;
/** Not a path's: the box mode timer and postgres.js's type fetch on a new
 *  connection. */
const NOISE_SQL = /mantle_actor_check_mode|from pg_catalog\.pg_type/;

/** The actor SET itself (client.ts setActorSql). */
const SET_SQL = /set_config\('mantle\.actor'/;
/** The RESET behind a write outside a transaction (client.ts
 *  RESET_ACTOR_SQL): sent after the caller has the write's answer. */
const RESET_SQL = /reset mantle\.actor;/;

type Kind = 'noise' | 'actor' | 'other';
const kindOf = (s: string): Kind =>
  NOISE_SQL.test(s) ? 'noise' : ACTOR_SQL.test(s) ? 'actor' : 'other';

/** A Postgres wire proxy that counts statements and round trips. */
class WireCounter {
  statements: string[] = [];
  roundTrips = 0;
  /** Round trips that sent only the actor's own statements. */
  actorRoundTrips = 0;
  /** Of those, the ones that carried the actor SET (A2b: must be 0, the SET
   *  always goes out with a statement of the path's own). */
  setRoundTrips = 0;
  /** Of those, the ones that only carried the RESET: off the caller's path
   *  (A2b1 audit, Q1). */
  resetRoundTrips = 0;
  /** Statements sent on the write role's connections (A2b2b). */
  writeRoleStatements = 0;
  lastAt = 0;
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();

  async start(host: string, port: number): Promise<number> {
    this.server = net.createServer((client) => {
      const upstream = net.connect(port, host);
      this.sockets.add(client).add(upstream);
      let buf = Buffer.alloc(0);
      let startup = true;
      let serverSpoke = true;
      /** The login role of this connection (its startup message). */
      let user = '';
      /** The kind of the statement this connection sent last: a send with
       *  no statement (Bind and Execute of a two-step one) is its. */
      let last: Kind = 'other';
      /** The kind of this connection's open round trip. */
      let open: Kind = 'other';
      /** Whether that round trip, while the actor's own, carried the SET. */
      let openSet = false;
      /** Whether that round trip, while the actor's own, carried a RESET. */
      let openReset = false;
      upstream.on('data', (d) => {
        serverSpoke = true;
        client.write(d);
      });
      client.on('data', (d: Buffer) => {
        upstream.write(d);
        buf = Buffer.concat([buf, d]);
        const kinds: Kind[] = [];
        let messages = 0;
        let sentSet = false;
        let sentReset = false;
        for (;;) {
          if (startup) {
            if (buf.length < 8) break;
            const len = buf.readInt32BE(0);
            if (buf.length < len) break;
            const code = buf.readInt32BE(4);
            // An SSL or GSS request comes before the startup message.
            if (code !== 80877103 && code !== 80877104) {
              startup = false;
              const kv = buf.subarray(8, len).toString('utf8').split('\0');
              for (let i = 0; i + 1 < kv.length; i += 2) if (kv[i] === 'user') user = kv[i + 1]!;
            }
            buf = buf.subarray(len);
            continue;
          }
          if (buf.length < 5) break;
          const len = buf.readInt32BE(1);
          if (buf.length < len + 1) break;
          const type = String.fromCharCode(buf[0]!);
          const body = buf.subarray(5, len + 1);
          let text: string | null = null;
          if (type === 'Q') text = cstring(body, 0);
          if (type === 'P') text = cstring(body, body.indexOf(0) + 1);
          // Bind first in a send: the rest of a two-step statement sent
          // before (its Parse), with whatever is pipelined behind it (the
          // write role's COMMIT, A2b2b): that statement's kind.
          if (type === 'B' && kinds.length === 0) kinds.push(last);
          if (text !== null) {
            last = kindOf(text);
            if (last !== 'noise' && user.startsWith('mantle_write_user')) {
              this.writeRoleStatements += 1;
            }
            if (SET_SQL.test(text)) sentSet = true;
            if (RESET_SQL.test(text)) sentReset = true;
            kinds.push(last);
            if (last !== 'noise') this.statements.push(text);
          }
          // Sign-in (p) and the goodbye (X) are no statement's round trip.
          if (type !== 'p' && type !== 'X') messages += 1;
          buf = buf.subarray(len + 1);
        }
        if (messages === 0) return;
        const counted = kinds.length ? kinds.filter((k) => k !== 'noise') : [last];
        if (counted.length === 0 || counted[0] === 'noise') {
          serverSpoke = false;
          return;
        }
        const kind: Kind = counted.every((k) => k === 'actor') ? 'actor' : 'other';
        if (serverSpoke) {
          this.roundTrips += 1;
          open = kind;
          openSet = kind === 'actor' && sentSet;
          openReset = kind === 'actor' && sentReset;
          if (kind === 'actor') this.actorRoundTrips += 1;
          if (openSet) this.setRoundTrips += 1;
          if (openReset) this.resetRoundTrips += 1;
        } else if (open === 'actor' && kind === 'other') {
          // The same round trip sent more than the actor's own after all.
          open = 'other';
          this.actorRoundTrips -= 1;
          if (openSet) this.setRoundTrips -= 1;
          if (openReset) this.resetRoundTrips -= 1;
          openSet = false;
          openReset = false;
        } else if (open === 'actor' && sentSet && !openSet) {
          openSet = true;
          this.setRoundTrips += 1;
        }
        serverSpoke = false;
        this.lastAt = Date.now();
      });
      const end = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', end).on('close', end);
      upstream.on('error', end).on('close', end);
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    return (this.server.address() as net.AddressInfo).port;
  }

  reset(): void {
    this.statements = [];
    this.roundTrips = 0;
    this.actorRoundTrips = 0;
    this.setRoundTrips = 0;
    this.resetRoundTrips = 0;
    this.writeRoleStatements = 0;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

function cstring(b: Buffer, from: number): string {
  const end = b.indexOf(0, from);
  return b.subarray(from, end < 0 ? b.length : end).toString('utf8');
}

/** One statement's shape: its values left out. */
const norm = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'U')
    .replace(/'(?:[^']|'')*'/g, "'S'")
    .trim();

const tally = (list: string[]) => {
  const m = new Map<string, number>();
  for (const s of list) m.set(s, (m.get(s) ?? 0) + 1);
  return m;
};

describe.skipIf(!DB_URL)('A2a: the actor check adds no round trip when off', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookie = '';
  let dir = '';
  const wire = new WireCounter();
  const owner = randomUUID();
  const note = randomUUID();
  const page = randomUUID();
  /** A member (A2b2b): a Moderator of Team, its page homed there. */
  const member = randomUUID();
  const memberPage = randomUUID();
  let memberCookie = '';
  const tag = `a2rt${randomUUID().slice(0, 6)}`;
  const agentSlug = `${tag}-admin`;
  let saves = 0;

  /** A fixture only the superuser may run (a box mode, a table, a trigger):
   *  the app's pool may log in as the runtime role (arch A9). */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  const call = async (p: string, method = 'GET', body?: unknown, as = cookie) => {
    const res = await app.request(p, {
      method,
      headers: { 'content-type': 'application/json', cookie: as },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    expect(res.status, `${method} ${p}: ${text.slice(0, 200)}`).toBeLessThan(300);
  };

  /** The login's work, bound as its process entry binds it in production:
   *  the MCP route names the login it authenticated. */
  const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
    m.runAsActor(m.loginActor(owner, 'rw'), fn);
  /** A turn's DBOS workflow reads its login as it is now (loginActorNow:
   *  a tagged lookup in warn, nothing with the check off). */
  const asTurnEntry = async <T>(fn: () => Promise<T>): Promise<T> =>
    m.runAsActor(await m.loginActorNow(owner, 'workflow:assistant-turn'), fn);

  const mcpClient = async () => {
    const ls = await import('@mantle/mcp-core');
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(
      server,
      await ls.prepareCallerTools({
        role: 'admin',
        anchorId: owner,
        loginId: owner,
        via: 'oauth',
        write: true,
      }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'test-client', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    return c;
  };

  const PATHS: Record<Path, () => Promise<unknown>> = {
    'tree load': () => call('/api/tree/notes'),
    'item open': () => call(`/api/notes/${note}`),
    search: () => call('/api/search?q=kettle'),
    'chat turn start': async () => {
      const ra = await import('@mantle/runtime/assistant');
      // The model answers 400 at once: the turn's work up to the model call.
      await asTurnEntry(() =>
        ra.runAssistantTurn(owner, `${tag} kettle`, { agentSlug, loginId: owner }),
      ).catch(() => undefined);
    },
    'MCP tool call': async () => {
      const c = await mcpClient();
      try {
        const res = (await asOwner(() =>
          c.callTool({ name: 'note_get', arguments: { id: note } }),
        )) as { isError?: boolean; content?: { text?: string }[] };
        expect(res.isError, JSON.stringify(res.content)).not.toBe(true);
      } finally {
        await c.close();
      }
    },
    'page save': () => {
      saves += 1;
      return call(`/api/pages/${page}/draft`, 'PUT', {
        doc: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: `save ${saves}` }] }],
        },
      });
    },
    'member page save': () => {
      saves += 1;
      return call(
        `/api/pages/${memberPage}/draft`,
        'PUT',
        {
          doc: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `member ${saves}` }] }],
          },
        },
        memberCookie,
      );
    },
  };

  /** Wait until the wire is quiet (detached writes land after a path). */
  const settle = async () => {
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      if (Date.now() - wire.lastAt > 150) return;
    }
  };

  /** One warm run, then the counted one. */
  const measure = async (p: Path, mode: 'off' | 'warn' | 'on') => {
    process.env.MANTLE_ACTOR_CHECK = mode;
    await PATHS[p]();
    await settle();
    wire.reset();
    await PATHS[p]();
    await settle();
    return {
      statements: [...wire.statements],
      roundTrips: wire.roundTrips,
      actorRoundTrips: wire.actorRoundTrips,
      setRoundTrips: wire.setRoundTrips,
      resetRoundTrips: wire.resetRoundTrips,
      writeRoleStatements: wire.writeRoleStatements,
    };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    const u = new URL(scratch.url);
    const port = await wire.start(u.hostname, Number(u.port || 5432));
    u.hostname = '127.0.0.1';
    u.port = String(port);
    dir = await mkdtemp(path.join(tmpdir(), 'a2a-rt-'));
    process.env.DATABASE_URL = u.toString();
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a2a-round-trips-secret-at-least-32-characters';
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('{"error":"refused in the round-trip test"}', { status: 400 }),
      ),
    );
    m = await import('@mantle/db');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    // A Team as a brain switched before 0286 has it (a new brain has none).
    await x(sql.raw(teamWorkspaceSql(owner)));
    const [ws] = await x<{ id: string }>(sql`select id::text as id from workspaces
      where owner_id = ${owner} and is_admin and archived_at is null`);
    const [agent] = await m.systemDb
      .insert(m.agents)
      .values({
        ownerId: owner,
        slug: agentSlug,
        name: 'Admin assistant',
        model: 'test/model',
        systemPrompt: 'p',
        role: 'assistant' as never,
        workspaceId: ws!.id,
      })
      .returning();
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${ws!.id}, 'assistant', ${agent!.id}, true) on conflict do nothing`);
    const [key] = await x<{ id: string }>(sql`insert into api_keys
      (user_id, service, label, key_enc) values (${owner}, 'openrouter', ${`${tag}-key`},
      decode('00', 'hex')) returning id::text`);
    await x(sql`update agents set api_key_id = ${key!.id} where id = ${agent!.id}`);
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${note}, ${owner}, 'note', ${`${tag} kettle note`}, 'notes')`);
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${page}, ${owner}, 'page', ${`${tag} page`}, 'pages')`);
    await x(sql`insert into pages (node_id, doc)
      values (${page}, '{"type":"doc","content":[]}'::jsonb)`);
    // The member and its page in Team (A2b2b): its save is a login write.
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
    const [team] = await x<{ id: string }>(sql`select id::text as id from workspaces
      where owner_id = ${owner} and name = 'Team' and not is_admin and archived_at is null`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${team!.id}, ${member}, true)
      on conflict (workspace_id, login_id) do update set moderator = true`);
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${memberPage}, ${owner}, 'page', ${`${tag} member page`}, 'pages')`);
    await x(sql`insert into pages (node_id, doc)
      values (${memberPage}, '{"type":"doc","content":[]}'::jsonb)`);
    await m.withHeads([memberPage], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${memberPage}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${memberPage}, ${team!.id}, true)`);
    });
    const tokens = await import('../lib/auth/tokens');
    cookie = `mantle_session=${tokens.buildSessionCookie(owner).value}`;
    memberCookie = `mantle_session=${tokens.buildSessionCookie(member).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    await m?.closeDb();
    await wire.stop();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('off sends nothing new; warn adds only the actor', async () => {
    const rows: string[] = [];
    const failures: string[] = [];
    for (const p of Object.keys(PATHS) as Path[]) {
      const off = await measure(p, 'off');
      const warn = await measure(p, 'warn');
      // A member's write (A2b2b): on the write role in warn and on (its
      // statements there counted), never off; on is held to warn's rules.
      const on = p === 'member page save' ? await measure(p, 'on') : null;
      const off2 = await measure(p, 'off');
      if (p === 'member page save') {
        if (off.writeRoleStatements !== 0) failures.push(`${p}: off sent to the write role`);
        if (warn.writeRoleStatements === 0)
          failures.push(`${p}: warn sent nothing to the write role`);
        if (on!.writeRoleStatements === 0) failures.push(`${p}: on sent nothing to the write role`);
        const own = (st: string) => ACTOR_SQL.test(st);
        const a = tally(off.statements.filter((st) => !own(st)).map(norm));
        const c = tally(on!.statements.filter((st) => !own(st)).map(norm));
        for (const k of new Set([...a.keys(), ...c.keys()])) {
          if ((a.get(k) ?? 0) !== (c.get(k) ?? 0)) {
            failures.push(`${p}: on differs from off on ${k.slice(0, 160)}`);
          }
        }
        if (on!.roundTrips - on!.actorRoundTrips !== off.roundTrips) {
          failures.push(
            `${p}: on takes ${on!.roundTrips} round trips (${on!.actorRoundTrips} of the actor), ` +
              `off ${off.roundTrips}`,
          );
        }
        if (on!.setRoundTrips !== 0) {
          failures.push(`${p}: on sends the SET alone in ${on!.setRoundTrips} round trips`);
        }
        rows.push(
          `| ${p} (on) | | ${on!.statements.length} / ${on!.roundTrips} | ` +
            `+${on!.statements.length - off.statements.length} / ` +
            `+${on!.roundTrips - off.roundTrips} (actor ${on!.actorRoundTrips}, SET ${on!.setRoundTrips}; ` +
            `write role: warn ${warn.writeRoleStatements}, on ${on!.writeRoleStatements} statements) |`,
        );
      }
      // A path whose count moved between two off runs is not settled.
      expect(off2.statements.length, `${p}: off is not stable`).toBe(off.statements.length);
      // (1) off: no statement sets or reads the actor.
      const actorOff = off.statements.filter((s) => ACTOR_SQL.test(s));
      if (actorOff.length) failures.push(`${p}: off sent the actor: ${actorOff[0]}`);
      // (2) warn: the same statements as off, plus the actor's own.
      const own = (s: string) => ACTOR_SQL.test(s);
      const a = tally(off.statements.filter((s) => !own(s)).map(norm));
      const b = tally(warn.statements.filter((s) => !own(s)).map(norm));
      for (const k of new Set([...a.keys(), ...b.keys()])) {
        if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) {
          failures.push(`${p}: warn differs from off on ${k.slice(0, 160)}`);
        }
      }
      // (3) warn: no round trip of its own, apart from those that send only
      // the actor's own statements (a lookup, the wrapper's RESET).
      if (warn.roundTrips - warn.actorRoundTrips !== off.roundTrips) {
        failures.push(
          `${p}: warn takes ${warn.roundTrips} round trips (${warn.actorRoundTrips} of the actor), ` +
            `off ${off.roundTrips}`,
        );
      }
      // (3b) the SET never takes a round trip of its own (A2b, the A2a
      // audit's LOW): counted apart from the lookups and the RESET.
      if (warn.setRoundTrips !== 0) {
        failures.push(`${p}: warn sends the actor SET alone in ${warn.setRoundTrips} round trips`);
      }
      // (3c) a write outside a transaction costs the caller nothing (A2b1
      // audit, Q1): page save has no actor lookup, so apart from the RESET
      // that runs after its answer it takes exactly off's round trips.
      if (p === 'page save' && warn.roundTrips - warn.resetRoundTrips !== off.roundTrips) {
        failures.push(
          `${p}: warn takes ${warn.roundTrips} round trips (${warn.resetRoundTrips} RESET), off ${off.roundTrips}`,
        );
      }
      // The A2a merge gate only: off against the counts before A2a.
      const base = OFF_BASELINE[p];
      if (
        process.env.MANTLE_RT_BASELINE &&
        base &&
        (off.statements.length > base.statements || off.roundTrips > base.roundTrips)
      ) {
        failures.push(
          `${p}: off sends ${off.statements.length} statements in ${off.roundTrips} round trips, ` +
            `${base.statements} in ${base.roundTrips} at fe884e7c2`,
        );
      }
      rows.push(
        `| ${p} | ${off.statements.length} / ${off.roundTrips} | ` +
          `${warn.statements.length} / ${warn.roundTrips} | ` +
          `+${warn.statements.length - off.statements.length} / ` +
          `+${warn.roundTrips - off.roundTrips} (actor ${warn.actorRoundTrips}, SET ${warn.setRoundTrips}, ` +
          `RESET after the answer ${warn.resetRoundTrips}) |`,
      );
    }
    if (process.env.MANTLE_RT_REPORT) {
      console.log(
        [
          '| path | off (statements / round trips) | warn | warn adds |',
          '| --- | --- | --- | --- |',
          ...rows,
        ].join('\n'),
      );
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it('the edit check on adds no statement and no round trip (arch A3a)', async () => {
    const rows: string[] = [];
    const failures: string[] = [];
    for (const p of Object.keys(PATHS) as Path[]) {
      // The actor check as the path runs it on dev: a member's write on the
      // write role (on), the rest in warn.
      const mode = p === 'member page save' ? 'on' : 'warn';
      const before = await measure(p, mode);
      await su(sql`select mantle_set_edit_check('on')`);
      let after: Awaited<ReturnType<typeof measure>>;
      try {
        after = await measure(p, mode);
      } finally {
        await su(sql`select mantle_set_edit_check('off')`);
      }
      const a = tally(before.statements.map(norm));
      const b = tally(after.statements.map(norm));
      for (const k of new Set([...a.keys(), ...b.keys()])) {
        if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) {
          failures.push(`${p}: the edit check differs on ${k.slice(0, 160)}`);
        }
      }
      if (after.roundTrips !== before.roundTrips) {
        failures.push(
          `${p}: ${after.roundTrips} round trips with the edit check on, ${before.roundTrips} off`,
        );
      }
      rows.push(
        `| ${p} (${mode}) | ${before.statements.length} / ${before.roundTrips} | ` +
          `${after.statements.length} / ${after.roundTrips} |`,
      );
    }
    if (process.env.MANTLE_RT_REPORT) {
      console.log(
        [
          '| path (actor check) | edit check off | edit check on |',
          '| --- | --- | --- |',
          ...rows,
        ].join('\n'),
      );
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
