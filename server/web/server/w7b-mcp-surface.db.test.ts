/**
 * W7b: one MCP surface for every login (workspaces plan 7.4), on a migrated
 * scratch database:
 *
 *  - a member's OAuth grant, a member's API key and a peer bound to the
 *    member each get the owner surface in the member's own scope: nothing
 *    adminOnly or of an Admin area is listed, and every listed tool, called
 *    as /api/mcp calls it, reads only the member's union (no reply names an
 *    Admin-only item or another member's private item);
 *  - an Admin user who is not the owner gets an Admin area only through the
 *    area check (its limits), listed and called;
 *  - a create without `workspace` lands by the route rule (the private
 *    workspace for a member, Admin for an Admin user), with one lands there
 *    when the caller moderates it, is refused otherwise, and every create
 *    reply names where it landed (`landedIn`).
 *
 * W7b fix round 1: the sweep's write side is real. Every item argument is
 * the OTHER member's private item; no reply names it or an Admin-only item;
 * those items, and the items the member only reads, do not change; every
 * call succeeds or fails for an expected reason (a timeout, a protocol
 * error or any other error fails); every create that succeeds names its
 * landing (the member's private workspace) and nothing made lands
 * elsewhere. Then, one by one: a member's write to a Team note or an Admin
 * app it only reads is refused (H1); a contact or a journal entry is
 * refused, nothing written and no backfill queued, the database refusing
 * it too (H2); a task, an event and a Recall map land by the rule (H2);
 * nothing that spends on the owner's keys is listed or reached (M4); a
 * copy is made at team rules with its author (low); a member brings back
 * its own deleted app and not another user's (low).
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

/** Every backfill a contact create would queue (H2: none for a member). */
const backfills = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('@mantle/email', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/email')>();
  return {
    ...orig,
    enqueueBackfills: async (...args: unknown[]) => void backfills.calls.push(args),
    enqueueBackfill: async (...args: unknown[]) => void backfills.calls.push(args),
  };
});

/** A permission or scope failure: never expected. */
const BAD =
  /permission denied|row-level security|turn scope|outside its turn scope|has no viewer level|only outside a viewer scope|already inside|needs an allowlisted reason|scope-lost|its scope would change/i;
/** The database's item-workspace refusals (the scope says no). */
const ITEM_WS =
  /not allowed to (add items to that folder|delete this item|move this item)|placing this app adds a workspace you do not moderate|a node's login can only be your own/i;
/** The refusals of a write to an item the scope may not change. */
const ITEM_RIGHTS =
  /You cannot change this item in your workspaces|read-only copy of an accepted item|is not in your workspaces: it is in a workspace you are not in/;

/** Why a sweep call may fail (as the W7a sweep): what the made-up
 *  arguments lacked, an item the member does not reach, a service that is
 *  off in the test, a context it is not in, or a refusal of the scope. Any
 *  other error fails the sweep. */
const EXPECTED: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'input',
    /is required|must be|must match|must name|must decode|pass (one of|either|content_|a branch id)|Provide either|nothing to (change|update)|needs at least|invalid|non-empty|specify a destination|unknown (pool|worker)|not a recognised|Undefined symbol|already exists in|is not a spreadsheet|is a binary file|not an image|no top-level heading|no h1 headings|not a \.mantleapp|is not allowlisted|validation|expected|code must be|is not deleted|from must be|\brequired\b|pass `|pass folder_id|already exists|not empty|no tab '|is not under files|has no mantleapp\.json|is not in Recently deleted|runs one INSERT, UPDATE, DELETE or REPLACE/i,
  ],
  [
    'not found',
    /\bnot found\b|^(Error: )?No (Recall map|revision|peers are configured)|no such message|no entry|not found or already decided|no indexed passages|No such app on your MCP connection/i,
  ],
  ['wrong type', /is an? \w+, not an? \w+ . pass/],
  [
    'offline',
    /offline in the W7b|cannot resolve host|returned 503|failed: 503|not enabled on this box|no \w+ API key configured|No Mapbox key|No default [\w_]+ worker|app-runtime manifest not found|no send-enabled email account|no enabled telegram account|Runner queues are disabled/i,
  ],
  [
    'context',
    /No one to act for|only runs on the team surface|can only run inside an agent turn|no heartbeat context|missing parent agent context|No enabled assistant agent|made by Mantle and found by its path/i,
  ],
  ['workspace', /not a Moderator of|You are not in a workspace/],
  ['item rights', ITEM_RIGHTS],
  ['item workspace', ITEM_WS],
];

/** The class of an expected failure, or null (the sweep fails on it). */
const expected = (msg: string): string | null => {
  if (BAD.test(msg) && !ITEM_WS.test(msg)) return null;
  for (const [name, re] of EXPECTED) if (re.test(msg)) return name;
  return null;
};

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
  const tag = `w7b${randomUUID().slice(0, 6)}`;
  const MARK = {
    admin: `${tag}ADMINONLY`,
    team: `${tag}TEAMNOTE`,
    other: `${tag}OTHERPRIVATE`,
    own: `${tag}OWNPRIVATE`,
  };
  /** Ids no member reply may name. */
  const forbidden: string[] = [];
  /** The other member's private items, by kind: every item argument of
   *  the sweep (W7b fix round 1). */
  const other = new Map<string, string>();
  /** Items the member reads but may not change: a Team note and an Admin
   *  app shared to Team with Read only. */
  const readOnly = new Map<string, string>();
  let adminWs = '';
  let teamWs = '';
  let projWs = '';
  let memPrivate = '';
  let mem2Private = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (who: string) => `${tag}-${who}@example.invalid`;

  /** Every item argument names the other member's private item. */
  const idFor = (key: string, slug: string): string => {
    const k = `${key} ${slug}`;
    if (/app/.test(k)) return other.get('app')!;
    if (/page/.test(k)) return other.get('page')!;
    return other.get('note')!;
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

  /** What no member call may change: the other member's items, the Admin
   *  ones, and the items the member only reads. */
  const guardedState = async () => {
    const ids = `{${[...forbidden, ...readOnly.values()].join(',')}}`;
    return JSON.stringify(
      await x(sql`select n.id::text, n.updated_at, n.title, n.data, n.home_ws, n.read_ws,
                         n.write_ws, n.superseded_by,
                         (select row(a.source, a.draft_source, a.published_build, a.author_level,
                                     a.manifest)::text
                            from apps a where a.node_id = n.id) as app,
                         (select count(*) from shares s where s.node_id = n.id) as shares,
                         (select count(*) from item_grants g where g.node_id = n.id) as grants
                    from nodes n where n.id = any(${ids}::uuid[]) order by n.id`),
    );
  };

  /** Make items homed in `ws`, as the system (the create home names it). */
  const makeIn = <T>(ws: string, fn: () => Promise<T>): Promise<T> =>
    m.asSystem(() => m.withCreateHome({ createWs: ws, privateWs: null, quiet: true }, fn), 'test');

  /** Grant `id` to `ws` with Read only. */
  const grantRead = (id: string, ws: string) =>
    m.asSystem(
      () =>
        m.withHeads([id], 'update', async (tx) => {
          await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                             values (${id}, ${ws}, false) on conflict do nothing`);
        }),
      'test',
    );

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
    mem2Private = await priv(mem2);
    const files = await import('@mantle/files');
    await m.asSystem(() => files.ensureFilesRootBranch(owner), 'test');
    const adminNote = await noteIn(adminWs, MARK.admin);
    other.set('note', await noteIn(mem2Private, MARK.other));
    other.set(
      'page',
      (await makeIn(mem2Private, () => content.createPage(owner, { title: `${MARK.other} page` })))
        .id,
    );
    other.set(
      'app',
      (await makeIn(mem2Private, () => content.createApp(owner, { title: `${MARK.other} app` })))
        .id,
    );
    forbidden.push(adminNote, ...other.values());
    // A Team note (a plain user of Team reads it, never edits it) and an
    // Admin app shared to Team with Read only.
    readOnly.set('note', await noteIn(teamWs, MARK.team));
    const adminApp = (
      await makeIn(adminWs, () => content.createApp(owner, { title: `${tag} admin app` }))
    ).id;
    await grantRead(adminApp, teamWs);
    readOnly.set('app', adminApp);
    await noteIn(memPrivate, MARK.own);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Every listed tool, called with schema-made arguments naming the other
   *  member's items: no reply names an item outside the member's union, no
   *  gated tool is listed, every call succeeds or fails for an expected
   *  reason, nothing guarded changes, and every create lands in the
   *  member's private workspace (W7b fix round 1). */
  const sweep = async (caller: import('@mantle/mcp-core').McpCaller) => {
    const c = await connect(caller);
    try {
      const listed = c.tools.map((tool) => tool.slug);
      expect(listed.length).toBeGreaterThan(40);
      expect(listed).toContain('workspaces_list');
      const gated = listed.filter((slug) => {
        const def = t.getBuiltin(slug);
        return (
          t.isAdminOnlyTool(slug, { ownerOnly: def?.ownerOnly }) ||
          t.toolAdminArea(slug) !== null ||
          ls.spendsOwnerKeys(slug) ||
          ls.ADMIN_KIND_CREATE_TOOL_SLUGS.has(slug)
        );
      });
      expect(gated).toEqual([]);
      // The member reads Team's note and its own, never the Admin one.
      const found = text(await c.call('note_list', {}));
      expect(found).toContain(MARK.team);
      expect(found).not.toContain(MARK.admin);
      expect(found).not.toContain(MARK.other);
      const before = await guardedState();
      const [clock] = await x<{ at: string }>(sql`select clock_timestamp()::text as at`);
      const bad: string[] = [];
      let ran = 0;
      for (const tool of ordered(c.tools)) {
        if (tool.slug === 'run_terminal') continue;
        const args = argsFor(tool.schema, tool.slug);
        const reply = await c.call(tool.slug, args);
        if (reply === 'timeout') {
          bad.push(`${tool.slug}: timed out after ${CALL_TIMEOUT_MS} ms`);
          continue;
        }
        const out = text(reply);
        // An id the call was given may come back in its refusal; any other
        // guarded id, and every guarded item's text, never does.
        const given = JSON.stringify(args);
        for (const leak of [
          MARK.admin,
          MARK.other,
          ...forbidden.filter((f) => !given.includes(f)),
        ]) {
          if (out.includes(leak)) bad.push(`${tool.slug}: names ${leak}`);
        }
        if (reply.isError) {
          if (!expected(out)) bad.push(`${tool.slug}: unexpected ${out.slice(0, 240)}`);
          continue;
        }
        ran += 1;
        if (BAD.test(out) && !ITEM_WS.test(out)) bad.push(`${tool.slug}: ${out.slice(0, 200)}`);
        if (ls.MCP_CREATE_TOOL_SLUGS.has(tool.slug)) {
          let landedIn: { id?: string } | undefined;
          try {
            landedIn = (JSON.parse(out) as { landedIn?: { id?: string } }).landedIn;
          } catch {
            landedIn = undefined;
          }
          if (landedIn?.id !== memPrivate) {
            bad.push(`${tool.slug}: landed ${JSON.stringify(landedIn ?? null)}`);
          }
        }
      }
      // Nothing the sweep made lands outside the member's private workspace
      // (a kind's root folder is the brain's structure).
      const strays = await x<{ type: string; title: string; ws: string | null }>(sql`
        select n.type::text as type, n.title, w.name as ws from nodes n
          left join workspaces w on w.id = n.home_ws
         where n.owner_id = ${owner} and n.created_at >= ${clock!.at}::timestamptz
           and n.home_ws is distinct from ${memPrivate}::uuid
           and not (n.type = 'branch' and nlevel(n.path) = 1)`);
      for (const r of strays) bad.push(`made ${r.type} "${r.title}" in ${r.ws ?? 'no workspace'}`);
      expect(bad).toEqual([]);
      expect(ran).toBeGreaterThan(10);
      expect(await guardedState()).toBe(before);
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
      access: 'read_write',
      areas: null,
      riskyTools: [],
      expiresAt: null,
      createdBy: mem,
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
         acts_as_login_id, write_enabled)
      values (${peerId}, ${owner}, ${peerNode}, ${`${tag} peer`}, 'https://peer.example.invalid',
              ${hashToken(peerToken)}, 'active', true, ${mem}, false)`);
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

  // ── W7b fix round 1, one by one ──────────────────────────────────────────

  const isRefused = (r: Reply | 'timeout') => r !== 'timeout' && r.isError === true;

  it('H1: a member’s write to a Team note or an Admin app it only reads is refused; nothing changes', async () => {
    const before = await guardedState();
    const c = await connect(memberCaller('oauth'));
    try {
      const note = readOnly.get('note')!;
      const app = readOnly.get('app')!;
      // The member reads both.
      expect(text(await c.call('note_get', { id: note }))).toContain(MARK.team);
      expect(text(await c.call('app_get', { id: app }))).toContain(`${tag} admin app`);
      const tries: [string, Json][] = [
        ['note_update', { id: note, title: `${tag} changed`, content: 'changed' }],
        ['note_delete', { id: note }],
        ['app_file_write', { id: app, path: 'app.tsx', content: 'export default 1;' }],
        ['app_publish', { id: app }],
        [
          'app_source_set',
          { id: app, entry: 'app.tsx', files: { 'app.tsx': 'export default 2;' } },
        ],
        ['app_delete', { id: app }],
      ];
      for (const [slug, args] of tries) {
        const r = await c.call(slug, args);
        expect(isRefused(r), `${slug}: ${r === 'timeout' ? r : text(r)}`).toBe(true);
        expect(text(r), slug).toMatch(ITEM_RIGHTS);
      }
    } finally {
      await c.close();
    }
    expect(await guardedState()).toBe(before);
    const [row] = await x<{ level: string }>(
      sql`select author_level as level from apps where node_id = ${readOnly.get('app')!}`,
    );
    expect(row?.level).toBe('admin');
  }, 300_000);

  it('H2: a member’s contact or journal entry is refused: nothing written, no backfill, the database refusing it too', async () => {
    const count = async () =>
      (
        await x<{ n: number }>(sql`select count(*)::int as n from nodes
          where owner_id = ${owner} and type in ('contact', 'journal', 'location')`)
      )[0]!.n;
    const before = await count();
    backfills.calls.length = 0;
    const c = await connect(memberCaller('oauth'));
    try {
      const listed = new Set(c.tools.map((tool) => tool.slug));
      for (const slug of ['contact_create', 'journal_create', 'location_save']) {
        expect(listed.has(slug), slug).toBe(false);
      }
      const contact = await c.call('contact_create', {
        first_name: `${tag} contact`,
        emails: ['someone@example.invalid'],
      });
      expect(isRefused(contact)).toBe(true);
      const journal = await c.call('journal_create', { body: `${tag} entry`, kind: 'identity' });
      expect(isRefused(journal)).toBe(true);
    } finally {
      await c.close();
    }
    // The database refuses it too: every call of the member runs under its
    // private workspace, and an Admin-only kind has no home there.
    for (const [slug, args] of [
      ['contact_create', { first_name: `${tag} contact 2`, emails: ['other@example.invalid'] }],
      ['journal_create', { body: `${tag} entry 2`, kind: 'identity' }],
    ] as const) {
      const def = t.getBuiltin(slug)!;
      const res = (await ls.runInOwnerMcpScope(
        mem,
        slug,
        () =>
          m.withCreateHome({ createWs: null, privateWs: memPrivate }, () =>
            def.handler(
              { ...args },
              {
                ownerId: owner,
                surface: { kind: 'owner', via: 'mcp', loginId: mem },
              },
            ),
          ),
        { adminLogin: false },
      )) as { ok?: boolean; isError?: boolean };
      expect(res.ok === true, slug).toBe(false);
    }
    expect(await count()).toBe(before);
    expect(backfills.calls).toEqual([]);
  }, 300_000);

  it('H2: a member’s task, event and Recall map land in its private workspace, or the one it names', async () => {
    const landed = (r: Reply | 'timeout') =>
      r === 'timeout'
        ? undefined
        : (JSON.parse(text(r)) as { landedIn?: { id: string } }).landedIn?.id;
    const c = await connect(memberCaller('oauth'));
    try {
      const task = await c.call('task_create', { title: `${tag} task` });
      expect(landed(task), text(task as Reply)).toBe(memPrivate);
      const event = await c.call('event_create', {
        title: `${tag} event`,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(landed(event), text(event as Reply)).toBe(memPrivate);
      const map = await c.call('recall_map_create', {
        title: `${tag} map`,
        enter_when: 'when testing W7b',
      });
      expect(landed(map), text(map as Reply)).toBe(memPrivate);
      const projTask = await c.call('task_create', {
        title: `${tag} proj task`,
        workspace: projWs,
      });
      expect(landed(projTask), text(projTask as Reply)).toBe(projWs);
      const projEvent = await c.call('event_create', {
        title: `${tag} proj event`,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        workspace: `${tag} Proj`,
      });
      expect(landed(projEvent), text(projEvent as Reply)).toBe(projWs);
      const teamTask = await c.call('task_create', {
        title: `${tag} team task`,
        workspace: teamWs,
      });
      expect(isRefused(teamTask)).toBe(true);
    } finally {
      await c.close();
    }
  }, 300_000);

  it('M4: nothing that spends on the owner’s keys is listed for a member, or reached', async () => {
    // Every spending builtin (search_chunks keeps its free ranking) and every
    // other tool on the owner's keys (W7 integration fix 2: route_map too).
    const { BUILTIN_TOOLS } = await import('@mantle/tools');
    const { OWNER_KEY_SPENDING_TOOLS } = await import('@mantle/mcp-core');
    const spending = [
      ...BUILTIN_TOOLS.filter((d) => d.spends && d.slug !== 'search_chunks').map((d) => d.slug),
      ...OWNER_KEY_SPENDING_TOOLS,
    ];
    expect(spending).toContain('route_map');
    for (const via of ['oauth', 'key', 'peer'] as const) {
      const c = await connect(memberCaller(via));
      try {
        const listed = new Set(c.tools.map((tool) => tool.slug));
        for (const slug of spending) {
          expect(listed.has(slug), `${via} ${slug}`).toBe(false);
          // Not registered: refused as an unknown tool, before any handler.
          const r = await c.call(slug, {});
          expect(isRefused(r), `${via} ${slug}`).toBe(true);
          expect(r === 'timeout' ? r : text(r), `${via} ${slug}`).toMatch(
            new RegExp(`Tool ${slug} not found`),
          );
        }
      } finally {
        await c.close();
      }
    }
    // The owner keeps them.
    const o = await connect({
      role: 'admin',
      anchorId: owner,
      loginId: owner,
      via: 'oauth',
      write: true,
    });
    try {
      const listed = new Set(o.tools.map((tool) => tool.slug));
      for (const slug of ['web_search_pro', 'generate_image', 'invoke_agent']) {
        expect(listed.has(slug), slug).toBe(true);
      }
    } finally {
      await o.close();
    }
  }, 300_000);

  it('low: a member’s copy of an app it reads is made at team rules, its author named', async () => {
    const c = await connect(memberCaller('oauth'));
    try {
      const copy = await c.call('app_duplicate', { id: readOnly.get('app')!, with_data: false });
      expect(isRefused(copy), text(copy as Reply)).toBe(false);
      const out = JSON.parse(text(copy as Reply)) as { id: string; landedIn?: { id: string } };
      expect(out.landedIn?.id).toBe(memPrivate);
      const [row] = await x<{ level: string; author: string | null }>(sql`
        select author_level as level, author_login_id::text as author from apps where node_id = ${out.id}`);
      expect(row).toEqual({ level: 'team', author: mem });
    } finally {
      await c.close();
    }
  }, 300_000);

  it('low: a member brings back its own deleted app, never another user’s', async () => {
    const mine = await connect(memberCaller('oauth'));
    const theirs = await connect({ ...memberCaller('oauth'), loginId: mem2 });
    try {
      const made = JSON.parse(
        text((await mine.call('app_create', { name: `${tag} trash mine` })) as Reply),
      ) as {
        id: string;
      };
      const madeOther = JSON.parse(
        text((await theirs.call('app_create', { name: `${tag} trash theirs` })) as Reply),
      ) as { id: string };
      expect(isRefused(await mine.call('app_delete', { id: made.id }))).toBe(false);
      expect(isRefused(await theirs.call('app_delete', { id: madeOther.id }))).toBe(false);
      const list = text((await mine.call('app_deleted_list', {})) as Reply);
      expect(list).toContain(made.id);
      expect(list).not.toContain(madeOther.id);
      const refused = await mine.call('app_undelete', { id: madeOther.id });
      expect(isRefused(refused)).toBe(true);
      const back = await mine.call('app_undelete', { id: made.id });
      expect(isRefused(back), text(back as Reply)).toBe(false);
      const rows = await x<{ id: string; home: string }>(sql`
        select id::text, home_ws::text as home from nodes
         where id in (${made.id}::uuid, ${madeOther.id}::uuid)`);
      expect(rows).toEqual([{ id: made.id, home: memPrivate }]);
      // The other member still finds its own in its trash.
      expect(text((await theirs.call('app_deleted_list', {})) as Reply)).toContain(madeOther.id);
    } finally {
      await mine.close();
      await theirs.close();
    }
  }, 300_000);
});
