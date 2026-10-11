/**
 * W7b: one MCP surface for every login (workspaces plan 7.4), on a migrated
 * scratch database:
 *
 *  - a member's OAuth grant, a member's API key and a peer bound to the
 *    member each get the owner surface in the member's own scope: nothing
 *    adminOnly or of an Admin area is listed, and every listed tool, called
 *    as /api/mcp calls it, reads only the member's union (no reply names an
 *    Admin-only item or another member's private item);
 *  - a client login stays refused (plan 21.9);
 *  - an Admin user who is not the owner gets an Admin area only through the
 *    area check (its limits), listed and called;
 *  - a create without `workspace` lands by the route rule (the private
 *    workspace for a member, Admin for an Admin user), with one lands there
 *    when the caller moderates it, is refused otherwise, and every create
 *    reply names where it landed (`landedIn`).
 *
 * Network is stubbed: nothing leaves the test.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7b-mcp-surface.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;
type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
  minimum?: number;
  minItems?: number;
  format?: string;
  anyOf?: Schema[];
  oneOf?: Schema[];
};
type Reply = { isError?: boolean; content?: { text?: string }[] };

const CALL_TIMEOUT_MS = 30_000;

const isDelete = (slug: string) =>
  /(_delete|_remove|_rm|_unshare|_cancel|_discard_draft|_reject)$/.test(slug);
const isCreate = (slug: string) => /_create$|_save$/.test(slug);

function typeOfSchema(s: Schema | undefined): string {
  if (!s) return 'string';
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (t) return t;
  const alt = s.anyOf?.[0] ?? s.oneOf?.[0];
  return alt ? typeOfSchema(alt) : 'string';
}

const text = (r: unknown) =>
  ((r as Reply | null)?.content ?? []).map((p) => p.text ?? '').join(' ');

describe.skipIf(!URL)('W7b: one MCP surface for every login', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let ls: typeof import('@mantle/mcp-core');
  let content: typeof import('@mantle/content');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const admin2 = randomUUID(); // an Admin user who is not the owner
  const mem = randomUUID();
  const mem2 = randomUUID();
  const cli = randomUUID();
  const tag = `w7b${randomUUID().slice(0, 6)}`;
  const MARK = {
    admin: `${tag}ADMINONLY`,
    team: `${tag}TEAMNOTE`,
    other: `${tag}OTHERPRIVATE`,
    own: `${tag}OWNPRIVATE`,
  };
  /** Ids no member reply may name. */
  const forbidden: string[] = [];
  /** Item ids the member reads, for the sweep's id arguments. */
  const readable = new Map<string, string>();
  let adminWs = '';
  let teamWs = '';
  let projWs = '';
  let memPrivate = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (who: string) => `${tag}-${who}@example.invalid`;

  const idFor = (key: string, slug: string): string => {
    const k = `${key} ${slug}`;
    if (/table/.test(k) && readable.has('table')) return readable.get('table')!;
    if (/page/.test(k) && readable.has('page')) return readable.get('page')!;
    return readable.get('note')!;
  };
  const valueFor = (key: string, s: Schema | undefined, slug: string): unknown => {
    if (s?.enum && s.enum.length > 0) return s.enum[0];
    const type = typeOfSchema(s);
    if (type === 'string') {
      if (key === 'id' || /(_id|Id)$/.test(key)) return idFor(key, slug);
      if (/url/i.test(key)) return 'https://example.invalid/w7b';
      if (key === 'parent' || /path/i.test(key)) return 'files';
      if (/email|^to$|address/i.test(key)) return 'nobody@example.invalid';
      if (s?.format === 'date-time' || /(_at|At|date|since|until|start|end)$/i.test(key)) {
        return new Date().toISOString();
      }
      if (/slug/i.test(key)) return `${tag}-${slug.replace(/_/g, '-')}`;
      if (/sql|query/i.test(key)) return 'select 1';
      if (key === 'q') return tag;
      return `${tag} ${slug}`;
    }
    if (type === 'number' || type === 'integer') return s?.minimum ?? 1;
    if (type === 'boolean') return false;
    if (type === 'array') {
      const n = s?.minItems ?? 0;
      if (n === 0) return [];
      return Array.from({ length: n }, () => valueFor(key.replace(/s$/, ''), s?.items, slug));
    }
    if (type === 'object') return argsFor(s ?? {}, slug);
    return tag;
  };
  const argsFor = (schema: Schema, slug: string): Json => {
    const out: Json = {};
    for (const k of schema.required ?? []) out[k] = valueFor(k, schema.properties?.[k], slug);
    return out;
  };
  const ordered = <T extends { slug: string }>(defs: readonly T[]): T[] => {
    const rank = (s: string) => (isCreate(s) ? 0 : isDelete(s) ? 2 : 1);
    return [...defs].sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug));
  };
  const timed = <T>(p: Promise<T>): Promise<T | 'timeout'> =>
    Promise.race([
      p,
      new Promise<'timeout'>((ok) => setTimeout(() => ok('timeout'), CALL_TIMEOUT_MS)),
    ]);

  /** A note homed in `ws`, made as the system (the create home names it). */
  const noteIn = async (ws: string, title: string): Promise<string> => {
    const row = await m.withCreateHome({ createWs: ws, privateWs: null }, () =>
      content.createNote(owner, { title, content: `${title} body` }),
    );
    const [home] = await x<{ home: string }>(
      sql`select home_ws::text as home from nodes where id = ${row.id}`,
    );
    expect(home?.home).toBe(ws);
    return row.id;
  };

  /** An MCP client on the one surface for `caller`, as /api/mcp serves it. */
  const connect = async (caller: import('@mantle/mcp-core').McpCaller) => {
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const prepared = await ls.prepareCallerTools(caller);
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(server, prepared);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'w7b', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    const tools = (await c.listTools()).tools.map((tool) => ({
      slug: tool.name,
      schema: tool.inputSchema as Schema,
    }));
    const call = async (name: string, args: Json) =>
      (await timed(
        c.callTool({ name, arguments: args }).catch((err: unknown) => ({
          isError: true,
          content: [{ text: `protocol: ${String(err)}` }],
        })),
      )) as Reply | 'timeout';
    return { prepared, tools, call, close: () => c.close() };
  };

  const memberCaller = (via: 'oauth' | 'key' | 'peer' = 'oauth') => ({
    role: 'member' as const,
    anchorId: owner,
    loginId: mem,
    via,
    write: true,
  });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7b-surface-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'w7b-surface-secret-at-least-32-characters!!';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_ADMIN_READS;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the W7b sweep', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    content = await import('@mantle/content');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Owner'),
      (${admin2}, ${email('admin2')}, 'x', false, 'admin', 'Second Admin'),
      (${mem}, ${email('mem')}, 'x', false, 'member', 'Member One'),
      (${mem2}, ${email('mem2')}, 'x', false, 'member', 'Member Two')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    // A client login, made after the migration (a brain with one is skipped).
    await x(sql`insert into auth.users (id, email, password_hash, role, display_name)
      values (${cli}, ${email('cli')}, 'x', 'client', 'Client')`);
    const ws = await x<{ id: string; admin: boolean; key: string | null }>(sql`
      select id::text, is_admin as admin, bridge_key as key from workspaces
       where owner_id = ${owner} and archived_at is null`);
    adminWs = ws.find((w) => w.admin)!.id;
    teamWs = ws.find((w) => w.key === 'team')!.id;
    // The member: a plain user of Team, a Moderator of a project workspace.
    const [proj] = await x<{ id: string }>(sql`
      insert into workspaces (owner_id, name) values (${owner}, ${`${tag} Proj`}) returning id::text`);
    projWs = proj!.id;
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${teamWs}, ${mem}, false), (${teamWs}, ${mem2}, false), (${projWs}, ${mem}, true)
      on conflict (workspace_id, login_id) do update set moderator = excluded.moderator`);
    const priv = async (login: string) =>
      (
        await x<{ ws: string }>(
          sql`select "public"."mantle_ws_private_workspace"(${login}::uuid)::text as ws`,
        )
      )[0]!.ws;
    memPrivate = await priv(mem);
    const mem2Private = await priv(mem2);
    const files = await import('@mantle/files');
    await m.asSystem(() => files.ensureFilesRootBranch(owner));
    const adminNote = await noteIn(adminWs, MARK.admin);
    const otherNote = await noteIn(mem2Private, MARK.other);
    forbidden.push(adminNote, otherNote);
    readable.set('note', await noteIn(teamWs, MARK.team));
    await noteIn(memPrivate, MARK.own);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Every listed tool, called with schema-made arguments: no reply names an
   *  item outside the member's union, and the gated tools are not listed. */
  const sweep = async (caller: import('@mantle/mcp-core').McpCaller) => {
    const c = await connect(caller);
    try {
      const listed = c.tools.map((tool) => tool.slug);
      expect(listed.length).toBeGreaterThan(40);
      expect(listed).toContain('workspaces_list');
      const gated = listed.filter((slug) => {
        const def = t.getBuiltin(slug);
        return (
          t.isAdminOnlyTool(slug, { ownerOnly: def?.ownerOnly }) || t.toolAdminArea(slug) !== null
        );
      });
      expect(gated).toEqual([]);
      // The member reads Team's note and its own, never the Admin one.
      const found = text(await c.call('note_list', {}));
      expect(found).toContain(MARK.team);
      expect(found).not.toContain(MARK.admin);
      expect(found).not.toContain(MARK.other);
      const leaks: string[] = [];
      for (const tool of ordered(c.tools)) {
        if (tool.slug === 'run_terminal') continue;
        const reply = await c.call(tool.slug, argsFor(tool.schema, tool.slug));
        const out = reply === 'timeout' ? '' : text(reply);
        for (const bad of [MARK.admin, MARK.other, ...forbidden]) {
          if (out.includes(bad)) leaks.push(`${tool.slug}: names ${bad}`);
        }
      }
      expect(leaks).toEqual([]);
      return listed;
    } finally {
      await c.close();
    }
  };

  it('a member OAuth grant: the one surface, only the member’s union', async () => {
    const listed = await sweep(memberCaller('oauth'));
    // Item tools that ran owner-only before W7b are there for a member now.
    for (const slug of ['app_create', 'app_file_write', 'tree_folder_create', 'note_create']) {
      expect(listed, slug).toContain(slug);
    }
  }, 1_200_000);

  it('a member API key and a member peer: the same union, narrowed by their switches', async () => {
    const keys = await import('../lib/access-keys');
    const auth = await import('../lib/mcp-auth');
    const minted = await keys.mintAccessKey({
      name: `${tag} key`,
      loginId: mem,
      loginRole: 'member',
      access: 'read_write',
      areas: null,
      riskyTools: [],
      expiresAt: null,
      createdBy: mem,
      sessionEpoch: null,
      maxLive: 50,
    });
    const keyCaller = await auth.resolveMcpCaller(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${minted!.key}` },
      }),
    );
    expect(keyCaller).toMatchObject({ role: 'member', loginId: mem, via: 'key', write: true });
    const keyListed = await sweep(keyCaller!);
    // The risky-tool rule narrows a key: an app's code is not changed by it.
    expect(keyListed).not.toContain('app_file_write');
    expect(keyListed).toContain('app_data_write');

    const { hashToken } = await import('@mantle/content/peers-crypto');
    const peerToken = `mtlpeer_${randomUUID().replace(/-/g, '')}`;
    const peerId = randomUUID();
    const peerNode = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${peerNode}, ${owner}, 'mantle_peer', ${`${tag} peer`}, 'peers')`);
    await x(sql`insert into mantle_peers
        (id, owner_id, node_id, display_name, base_url, inbound_token_hash, status, enabled,
         acts_as_login_id, acts_as_role, write_enabled)
      values (${peerId}, ${owner}, ${peerNode}, ${`${tag} peer`}, 'https://peer.example.invalid',
              ${hashToken(peerToken)}, 'active', true, ${mem}, 'member', false)`);
    const peerCaller = await auth.resolveMcpCaller(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${peerToken}` },
      }),
    );
    expect(peerCaller).toMatchObject({ role: 'member', loginId: mem, via: 'peer', write: false });
    const peerListed = await sweep(peerCaller!);
    // Write off: read-only tools only.
    for (const slug of peerListed) expect(ls.isMcpToolReadOnly(slug), slug).toBe(true);
  }, 1_800_000);

  it('a client login stays refused', async () => {
    const prepared = await ls.prepareCallerTools({
      role: 'client',
      anchorId: owner,
      loginId: cli,
      via: 'oauth',
      write: true,
    });
    expect(prepared).toMatchObject({ kind: 'refused', message: ls.CLIENT_LOGIN_REFUSED });
    expect(ls.preparedAllows(prepared, 'search')).toBe(false);
  });

  it('an Admin user who is not the owner: an Admin area only through the area check', async () => {
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${admin2}, true)
      on conflict (workspace_id, login_id) do update set moderator = true`);
    await x(sql`update workspace_users set limits = '{"areas":{"keys":false}}'::jsonb
      where workspace_id = ${adminWs} and login_id = ${admin2}`);
    const c = await connect({
      role: 'admin',
      anchorId: owner,
      loginId: admin2,
      via: 'oauth',
      write: true,
    });
    try {
      const listed = new Set(c.tools.map((tool) => tool.slug));
      expect(c.prepared.kind === 'owner' && c.prepared.view?.holdsAdmin).toBe(true);
      // adminOnly and the areas left on: listed.
      expect(listed.has('replay_window')).toBe(true);
      expect(listed.has('model_pool_list')).toBe(true);
      // The keys area is off for this user: not listed, and refused if called.
      expect(listed.has('secret_create')).toBe(false);
      expect(listed.has('api_key_refs')).toBe(false);
      const refused = await ls.runInOwnerMcpScope(
        admin2,
        'api_key_refs',
        async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }),
        { adminLogin: true },
      );
      expect(text(refused)).toMatch(/keys area is on/);
    } finally {
      await c.close();
      await x(sql`update workspace_users set limits = '{}'::jsonb
        where workspace_id = ${adminWs} and login_id = ${admin2}`);
    }
  }, 300_000);

  describe('creates: the route rule, an optional workspace, and where it landed', () => {
    const landed = (r: unknown) =>
      (JSON.parse(text(r)) as { landedIn?: { id: string; name: string } }).landedIn;

    it('a member: no workspace = its private one; a moderated one = there; else refused', async () => {
      const c = await connect(memberCaller('oauth'));
      try {
        const plain = await c.call('note_create', { title: `${tag} plain`, content: 'x' });
        expect(landed(plain)?.id, text(plain)).toBe(memPrivate);
        const proj = await c.call('note_create', {
          title: `${tag} proj`,
          content: 'x',
          workspace: `${tag} Proj`,
        });
        expect(landed(proj)?.id, text(proj)).toBe(projWs);
        const byId = await c.call('page_create', {
          title: `${tag} proj page`,
          markdown: 'x',
          workspace: projWs,
        });
        expect(landed(byId)?.id, text(byId)).toBe(projWs);
        // Team: a user, not a Moderator.
        const team = (await c.call('note_create', {
          title: `${tag} team`,
          content: 'x',
          workspace: teamWs,
        })) as Reply;
        expect(team.isError).toBe(true);
        expect(text(team)).toMatch(/not a Moderator/);
        // Admin: not one of the member's workspaces at all.
        const admin = (await c.call('note_create', {
          title: `${tag} admin`,
          content: 'x',
          workspace: adminWs,
        })) as Reply;
        expect(admin.isError).toBe(true);
        expect(text(admin)).toMatch(/not in a workspace/);
        const [n] = await x<{ n: number }>(sql`select count(*)::int as n from nodes
          where owner_id = ${owner} and title in (${`${tag} team`}, ${`${tag} admin`})`);
        expect(n?.n).toBe(0);
        // An app the member makes is at team rules, its author named.
        const app = await c.call('app_create', { name: `${tag} app` });
        expect(landed(app)?.id, text(app)).toBe(memPrivate);
        const appId = (JSON.parse(text(app)) as { id: string }).id;
        const [row] = await x<{ level: string; author: string | null }>(sql`
          select author_level as level, author_login_id::text as author from apps where node_id = ${appId}`);
        expect(row).toEqual({ level: 'team', author: mem });
      } finally {
        await c.close();
      }
    }, 300_000);

    it('an Admin user: no workspace = Admin; a workspace it moderates = there', async () => {
      const c = await connect({
        role: 'admin',
        anchorId: owner,
        loginId: owner,
        via: 'oauth',
        write: true,
      });
      try {
        const plain = await c.call('note_create', { title: `${tag} owner plain`, content: 'x' });
        expect(landed(plain)?.id, text(plain)).toBe(adminWs);
        const team = await c.call('note_create', {
          title: `${tag} owner team`,
          content: 'x',
          workspace: 'Team',
        });
        expect(landed(team)?.id, text(team)).toBe(teamWs);
      } finally {
        await c.close();
      }
    }, 300_000);
  });
});
