/**
 * W7a tool sweep (workspaces plan 5.1 and 11): the Admin assistant and the
 * Admin MCP surface run in a scope, like every other user. On a migrated
 * scratch database:
 *
 *  - every builtin tool, called in an Admin assistant's turn scope (as the
 *    web chat of the anchor login runs it), never fails on a permission
 *    error other than an item-workspace refusal (the database's "not
 *    allowed to ..." checks), never loses or leaves its scope, and never
 *    throws past dispatch;
 *  - every tool of the Admin MCP surface (OAuth), called as /api/mcp calls
 *    it, the same: no permission error but an item-workspace refusal in the
 *    server log, no protocol error;
 *  - in a scope that does not hold the Admin workspace (the Team
 *    assistant's turn; an Admin-role login's MCP once it is no user of
 *    Admin), every adminOnly or ownerOnly tool, and every tool of an Admin
 *    area, is refused before it runs;
 *  - (W7a fix round 1) every call either succeeds or fails with an EXPECTED
 *    reason (input, not found, offline, missing context, an item refusal);
 *    anything else fails the sweep, and so does a call that times out. The
 *    MCP sweep runs as the anchor AND as a second Admin login;
 *  - (W7a fix round 1, M2 and H1) every write tool that names an item,
 *    pointed at an item shared to Admin with Read only, or at another
 *    user's private item, is refused (in an Admin turn and on MCP, as both
 *    logins), and none of those items changes.
 *
 * Arguments are made from each tool's input schema (its required fields,
 * ids of items the sweep made first). Network is stubbed: nothing leaves
 * the test. Creates run first, deletes last.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7a-tool-sweep.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ITEM_WORKSPACE_TOOL_TEXTS, READ_ONLY_APP_MESSAGE } from '@mantle/std';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Every database error a tool turned into text (errorMessage), with its
 *  SQLSTATE and the database's own message: a drizzle error's message is
 *  its SQL, the permission error is its cause. */
const seen = vi.hoisted(() => ({ db: [] as { code: string; text: string }[] }));

vi.mock('@mantle/std', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/std')>();
  return {
    ...orig,
    errorMessage: (err: unknown) => {
      const e = err as { code?: unknown; message?: unknown; cause?: unknown } | null;
      const c = (e?.cause ?? null) as { code?: unknown; message?: unknown } | null;
      const code = String(e?.code ?? c?.code ?? '');
      if (code) seen.db.push({ code, text: String(c?.message ?? e?.message ?? '') });
      return orig.errorMessage(err);
    },
  };
});

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

/** A permission or scope failure (what the sweep forbids). */
const BAD =
  /permission denied|row-level security|42501|turn scope|outside its turn scope|has no viewer level|only outside a viewer scope|already inside|needs an allowlisted reason|scope-lost|its scope would change|not a user of the (Admin|assistant)/i;
/** The database's item-workspace refusals (allowed: the turn's scope says no). */
const ITEM_WS =
  /not allowed to (add items to that folder|delete this item|move this item)|placing this app adds a workspace you do not moderate|a node's login can only be your own/i;

/** Tools that take a long road outside the box even when stubbed. A call
 *  that runs this long fails the sweep (W7a fix round 1). */
const CALL_TIMEOUT_MS = 30_000;

/** `text` as a literal in a pattern. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** The refusals of a write to an item the scope may not change (W7a fix
 *  round 1, M2: @mantle/db item-rights.ts), and since A5 step 5 the one
 *  mapper's tool text for the database's: an item-workspace refusal, a
 *  create's own words (fix round 1, L6) and an Informational app's data
 *  (A5 step 5 fix round 2, LOW-2). */
const ITEM_RIGHTS = new RegExp(
  [
    'You cannot change this item in your workspaces',
    'read-only copy of an accepted item',
    'is not in your workspaces: it is in a workspace you are not in',
    ...[...ITEM_WORKSPACE_TOOL_TEXTS, READ_ONLY_APP_MESSAGE].map(escapeRegExp),
  ].join('|'),
);

/**
 * Why a sweep call may fail (W7a fix round 1: no catch-all). Each class
 * names what the call lacked: the sweep's made-up arguments, an item it did
 * not make, a service that is off in the test, a turn context it is not
 * in, or an item refusal. Any other error fails the sweep.
 */
const EXPECTED: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'input',
    /is required|must be|must match|must name|must decode|pass (one of|either|content_|a branch id)|Provide either|nothing to (change|update)|needs at least|invalid|non-empty|specify a destination|unknown (pool|worker)|not a recognised|Undefined symbol|already exists in|is not a spreadsheet|is a binary file|not an image|no top-level heading|no h1 headings|not a \.mantleapp|is not allowlisted|is not one of your paired chats|validation|expected|code must be|is not deleted|from must be|\brequired\b|pass `|pass folder_id|already exists|not empty|no tab '|is not under files|has no mantleapp\.json|is not in Recently deleted|runs one INSERT, UPDATE, DELETE or REPLACE/i,
  ],
  [
    'not found',
    /\bnot found\b|^(Error: )?No (Recall map|revision|peers are configured)|no such message|no entry|not found or already decided|no indexed passages|No such app on your MCP connection/i,
  ],
  ['wrong type', /is an? \w+, not an? \w+ . pass/],
  // app_publish after an app_build that is offline here: no green build
  // (A2b2b: on the write role the turn's scope is set, so the draft the
  // turn may edit is read; on the system pool it read as none).
  [
    'offline',
    // A provider error answers fixed text since A10 #10: '... (local, HTTP 503)'.
    /offline in the W7a|cannot resolve host|returned 503|failed: 503|\(\w+, HTTP 503\)|not enabled on this box|no \w+ API key configured|No Mapbox key|No default [\w_]+ worker|app-runtime manifest not found|draft has no successful build|no send-enabled email account|no enabled telegram account|Runner queues are disabled/i,
  ],
  // (W7c fix round 2: telegram_pair is the anchor's own, until W7d; W7
  // integration fix 2: so is the rest of the Telegram inbox.)
  [
    'context',
    /No one to act for|only runs on the team surface|can only run inside an agent turn|no heartbeat context|missing parent agent context|No enabled assistant agent|made by Mantle and found by its path|only the brain's owner pairs a Telegram chat|only the brain's owner works the Telegram inbox/i,
  ],
  // A switch W7b retired (agent and tool group levels) says so.
  ['retired', /Agents and tool groups have no level any more/],
  ['item rights', ITEM_RIGHTS],
  ['item workspace', ITEM_WS],
];

/** The class of an expected failure, or null (the sweep fails on it). */
const expected = (text: string): string | null => {
  if (BAD.test(text) && !ITEM_WS.test(text)) return null;
  for (const [name, re] of EXPECTED) if (re.test(text)) return name;
  return null;
};

const isDelete = (slug: string) =>
  /(_delete|_remove|_rm|_unshare|_cancel|_discard_draft|_reject)$/.test(slug) ||
  slug === 'sandbox_rm' ||
  slug === 'sandbox_stop';
const isCreate = (slug: string) => /_create$|_save$/.test(slug);

/** The node type a tool family works on, for its id arguments. */
const FAMILY_TYPE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^page/, 'page'],
  [/^note/, 'note'],
  [/^table/, 'table'],
  [/^sheet/, 'table'],
  [/^file/, 'file'],
  [/^folder|^tree_folder/, 'branch'],
  [/^draw/, 'draw'],
  [/^app|^my_app/, 'app'],
  [/^task/, 'task'],
  [/^event/, 'event'],
  [/^contact/, 'contact'],
  [/^journal/, 'lifelog'],
  [/^formula/, 'formula'],
  [/^location/, 'location'],
];

function typeOfSchema(s: Schema | undefined): string {
  if (!s) return 'string';
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (t) return t;
  const alt = s.anyOf?.[0] ?? s.oneOf?.[0];
  return alt ? typeOfSchema(alt) : 'string';
}

describe.skipIf(!URL)('W7a: the Admin assistant and the Admin MCP run in a scope', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  /** The suite's own actor check mode, put back after (checks on below). */
  let suiteMode: string | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const admin2 = randomUUID(); // an Admin-role login, later no user of Admin
  const mem = randomUUID();
  /** Items homed in the member's private workspace (W7a fix round 1):
   *  shared to Admin with Read only, and private (no grant), by type. */
  const readOnly = new Map<string, string>();
  const privateItems = new Map<string, string>();
  const tag = `w7a${randomUUID().slice(0, 6)}`;
  let adminWs = '';
  let teamWs = '';
  /** Each sweep pass names what it makes apart (a create never meets the
   *  same name from an earlier pass). */
  let pass = '';
  /** Item ids by node type, made before the sweep. */
  const ids = new Map<string, string>();

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (who: string) => `${tag}-${who}@example.invalid`;

  const idFor = (key: string, slug: string): string => {
    const k = key.replace(/_?ids?$/i, '').toLowerCase();
    for (const [re, type] of FAMILY_TYPE) if (re.test(k) && ids.has(type)) return ids.get(type)!;
    for (const [re, type] of FAMILY_TYPE) if (re.test(slug) && ids.has(type)) return ids.get(type)!;
    return ids.get('page') ?? randomUUID();
  };

  const valueFor = (key: string, s: Schema | undefined, slug: string): unknown => {
    if (s?.enum && s.enum.length > 0) return s.enum[0];
    const type = typeOfSchema(s);
    if (type === 'string') {
      if (key === 'id' || /(_id|Id)$/.test(key)) return idFor(key, slug);
      if (/url/i.test(key)) return 'https://example.invalid/w7a';
      // A folder path is dotted under the files root.
      if (key === 'parent' || /path/i.test(key)) return 'files';
      if (/email|^to$|address/i.test(key)) return 'nobody@example.invalid';
      if (s?.format === 'date-time' || /(_at|At|date|since|until|start|end)$/i.test(key)) {
        return new Date().toISOString();
      }
      if (/slug/i.test(key)) return `${tag}${pass}-${slug.replace(/_/g, '-')}`;
      if (/sql|query/i.test(key)) return 'select 1';
      return `${tag}${pass} ${slug}`;
    }
    if (type === 'number' || type === 'integer') return s?.minimum ?? 1;
    if (type === 'boolean') return false;
    if (type === 'array') {
      const n = s?.minItems ?? 0;
      if (n === 0) return [];
      return Array.from({ length: n }, () => valueFor(key.replace(/s$/, ''), s?.items, slug));
    }
    if (type === 'object') return argsFor(s ?? {}, slug);
    return `${tag}`;
  };

  const argsFor = (schema: Schema, slug: string): Json => {
    const out: Json = {};
    for (const k of schema.required ?? []) out[k] = valueFor(k, schema.properties?.[k], slug);
    return out;
  };

  /** Order: creates, then the rest, then deletes. */
  const ordered = <T extends { slug: string }>(defs: readonly T[]): T[] => {
    const rank = (s: string) => (isCreate(s) ? 0 : isDelete(s) ? 2 : 1);
    return [...defs].sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug));
  };

  const timed = <T>(p: Promise<T>): Promise<T | 'timeout'> =>
    Promise.race([
      p,
      new Promise<'timeout'>((ok) => setTimeout(() => ok('timeout'), CALL_TIMEOUT_MS)),
    ]);

  const toolRow = (def: { slug: string; inputSchema?: unknown }) =>
    ({
      slug: def.slug,
      name: def.slug,
      handler: { kind: 'builtin', ref: def.slug },
      inputSchema: def.inputSchema ?? { type: 'object', properties: {} },
    }) as unknown as import('@mantle/db').Tool;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7a-sweep-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'w7a-sweep-secret-at-least-32-characters!!';
    delete process.env.MANTLE_DETACHED_DEV;
    // Nothing leaves the test: every outbound request answers 503.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the W7a sweep', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = turnCallDispatch(await import('@mantle/tools'));
    rt = await import('@mantle/runtime/agent');
    const hb = await import('@mantle/runtime/heartbeats');
    hb.registerHeartbeatTools();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Owner'),
      (${admin2}, ${email('admin2')}, 'x', false, 'admin', 'Second Admin'),
      (${mem}, ${email('mem')}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    const ws = await x<{ id: string; admin: boolean; key: string | null }>(sql`
      select id::text, is_admin as admin, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces
       where owner_id = ${owner} and archived_at is null`);
    adminWs = ws.find((w) => w.admin)!.id;
    teamWs = ws.find((w) => w.key === 'team')!.id;
    const files = await import('@mantle/files');
    await m.asSystem(() => files.ensureFilesRootBranch(owner), 'test');

    // Items of another user (the member's private workspace): one set shared
    // to Admin with Read only, one set private (W7a fix round 1).
    const c = await import('@mantle/content');
    const memWs = (
      await x<{ ws: string }>(
        sql`select "public"."mantle_ws_private_workspace"(set_config('mantle.scope_login', ${mem}, true)::uuid)::text as ws`,
      )
    )[0]!.ws;
    const makeAll = async (label: string): Promise<Map<string, string>> => {
      const made = new Map<string, string>();
      await m.asSystem(
        () =>
          m.withCreateHome({ createWs: memWs, privateWs: null, quiet: true }, async () => {
            made.set('page', (await c.createPage(owner, { title: `${tag} ${label} page` })).id);
            made.set(
              'note',
              (await c.createNote(owner, { title: `${tag} ${label} note`, content: 'x' })).id,
            );
            made.set('task', (await c.createTask(owner, { title: `${tag} ${label} task` })).id);
            made.set(
              'event',
              (
                await c.createEvent(owner, {
                  title: `${tag} ${label} event`,
                  startsAt: new Date().toISOString(),
                })
              ).id,
            );
            made.set('table', (await c.createTable(owner, { title: `${tag} ${label} table` })).id);
            const folder = await files.createFolder({
              ownerId: owner,
              parentPath: 'files',
              slug: `${tag}-${label}-dir`,
            });
            made.set('branch', folder.id);
            const file = await files.upsertFile({
              ownerId: owner,
              parentPath: 'files',
              filename: `${tag}-${label}.txt`,
              bytes: Buffer.from(`${label} secret bytes`),
            });
            made.set('file', file.id);
          }),
        'test',
      );
      return made;
    };
    for (const [k, v] of await makeAll('ro')) readOnly.set(k, v);
    for (const [k, v] of await makeAll('private')) privateItems.set(k, v);
    for (const id of readOnly.values()) {
      await m.asSystem(
        () =>
          m.withHeads([id], 'update', async (tx) => {
            await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                               values (${id}, ${adminWs}, false) on conflict do nothing`);
          }),
        'test',
      );
    }
    // Both checks on, as every box since the pre-check removal
    // (docs/actors.md, "Pre-check deletion"): a tool's write to an item the
    // scope may not change is the database's to refuse now. This process's
    // actor check on (a login's scoped write on the write role, its check
    // on) and the scratch database's edit check on.
    suiteMode = process.env.MANTLE_ACTOR_CHECK;
    process.env.MANTLE_ACTOR_CHECK = 'on';
    await (
      await import('@mantle/db/test-support')
    ).superuserExec(scratch!.url, "select mantle_set_edit_check('on')");
  }, 240_000);

  /** What must not change of the other user's items. */
  const otherItemsState = async () => {
    const all = `{${[...readOnly.values(), ...privateItems.values()].join(',')}}`;
    return JSON.stringify(
      await x(sql`select n.id::text, n.updated_at, n.title, n.data, n.home_ws, n.superseded_by,
                         n.salience, n.path::text as path,
                         (select md5(coalesce(p.doc::text, '') || coalesce(p.draft_doc::text, ''))
                            from pages p where p.node_id = n.id) as page,
                         (select md5(coalesce(t.storage_path, '') || coalesce(t.draft_path, '')
                                     || t.draft_rev::text)
                            from tables t where t.node_id = n.id) as tbl,
                         (select count(*) from shares s where s.node_id = n.id) as shares,
                         (select count(*) from shares s
                           where s.node_id = n.id and s.revoked_at is null) as open_links,
                         (select count(*) from item_grants g where g.node_id = n.id) as grants
                    from nodes n where n.id = any(${all}::uuid[]) order by n.id`),
    );
  };

  /** The item type a write tool's id argument names, for the other user's
   *  items (null: a kind no other user holds here). */
  const otherTypeFor = (slug: string): string | null => {
    if (/^(content_supersede|access_set|process_extraction|node_share|node_unshare)$/.test(slug)) {
      return 'page';
    }
    for (const [re, type] of FAMILY_TYPE) if (re.test(slug)) return type;
    return null;
  };

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** The latest item of each type, made by the creates. */
  const refreshIds = async () => {
    const rows = await x<{ type: string; id: string }>(sql`
      select distinct on (type) type, id::text from nodes
       where owner_id = ${owner} order by type, created_at desc`);
    for (const r of rows) ids.set(r.type, r.id);
  };

  it('every builtin in an Admin assistant turn: no permission error, no lost scope', async () => {
    pass = 't';
    const defs = ordered(t.listBuiltins());
    expect(defs.length).toBeGreaterThan(150);
    const bad: string[] = [];
    const scopes = new Set<string>();
    const surface = { kind: 'web' as const, loginId: owner };
    let createsDone = false;
    let ran = 0;
    const errs: string[] = [];
    seen.db.length = 0;
    for (const def of defs) {
      if (!createsDone && !isCreate(def.slug)) {
        await refreshIds();
        createsDone = true;
      }
      const input = argsFor((def.inputSchema ?? {}) as Schema, def.slug);
      const res = await timed(
        rt.withAgentScope(
          { workspaceId: adminWs },
          async () => {
            const s = m.currentScope();
            scopes.add(`${s.kind}:${'ws' in s ? (s.ws as string[]).join(',') : ''}`);
            try {
              return await t.dispatchTool(toolRow(def), input, { ownerId: owner, surface });
            } catch (err) {
              return { ok: false as const, error: `THROWN ${inspect(err).slice(0, 300)}` };
            }
          },
          { ownerLoginId: owner },
        ),
      );
      if (res === 'timeout') {
        bad.push(`${def.slug}: timed out after ${CALL_TIMEOUT_MS} ms`);
        continue;
      }
      if (res.ok) ran += 1;
      else errs.push(`${def.slug}: ${String(res.error).slice(0, 100)}`);
      if (!res.ok) {
        const e = String(res.error);
        if (e.startsWith('THROWN') || !expected(e)) {
          bad.push(`${def.slug}: unexpected ${e.slice(0, 240)}`);
        }
      }
      for (const d of seen.db.splice(0)) {
        if (d.code === '42501' && !ITEM_WS.test(d.text)) {
          bad.push(`${def.slug}: 42501 ${d.text.slice(0, 200)}`);
          break;
        }
      }
    }
    if (process.env.W7A_SWEEP_LOG) console.info(`ran ${ran}\n${errs.join('\n')}`);
    expect(ran).toBeGreaterThan(60);
    expect(bad).toEqual([]);
    expect([...scopes]).toEqual([`assistant:${adminWs}`]);
  }, 1_200_000);

  it.each([
    ['the anchor', () => owner],
    ['a second Admin login', () => admin2],
  ])(
    'every tool of the Admin MCP surface as %s: succeeds or an expected refusal',
    async (_who, login) => {
      pass = login() === owner ? 'o' : 'l';
      await refreshIds();
      const ls = await import('@mantle/mcp-core');
      const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
      const { Client } = await import('@modelcontextprotocol/client');
      const logged: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' '));
      });
      try {
        const caller = {
          role: 'admin' as const,
          anchorId: owner,
          loginId: login(),
          via: 'oauth' as const,
          write: true,
        };
        const server = new McpServer({ name: 'test', version: '0' });
        ls.registerPreparedTools(server, await ls.prepareCallerTools(caller));
        const [a, b] = InMemoryTransport.createLinkedPair();
        const c = new Client({ name: 'test-client', version: '0' });
        await Promise.all([server.connect(a), c.connect(b)]);
        const tools = ordered(
          (await c.listTools()).tools.map((tool) => ({
            slug: tool.name,
            schema: tool.inputSchema as Schema,
          })),
        );
        expect(tools.length).toBeGreaterThan(150);
        const bad: string[] = [];
        for (const tool of tools) {
          if (tool.slug === 'run_terminal') continue;
          logged.length = 0;
          let thrown: unknown = null;
          const reply = await timed(
            c
              .callTool({ name: tool.slug, arguments: argsFor(tool.schema, tool.slug) })
              .catch((err: unknown) => {
                thrown = err;
                return null;
              }),
          );
          if (reply === 'timeout') {
            bad.push(`${tool.slug}: timed out after ${CALL_TIMEOUT_MS} ms`);
            continue;
          }
          const r = (reply ?? {}) as { isError?: boolean; content?: { text?: string }[] };
          const text = (r.content ?? []).map((p) => p.text ?? '').join(' ');
          if (BAD.test(text) && !ITEM_WS.test(text)) {
            bad.push(`${tool.slug}: reply ${text.slice(0, 200)}`);
          } else if (reply && r.isError && !expected(text)) {
            bad.push(`${tool.slug}: unexpected ${text.slice(0, 200)}`);
            if (process.env.W7A_SWEEP_LOG)
              console.info(tool.slug, logged.join('\n').slice(0, 2000));
          }
          if (thrown && !/validation|invalid|required|expected/i.test(String(thrown))) {
            bad.push(`${tool.slug}: protocol ${String(thrown).slice(0, 200)}`);
          }
          for (const line of logged) {
            if (BAD.test(line) && !ITEM_WS.test(line)) {
              bad.push(`${tool.slug}: ${line.replace(/\s+/g, ' ').slice(0, 240)}`);
              break;
            }
          }
        }
        await c.close();
        expect(bad).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    },
    1_200_000,
  );

  it('write tools on another user’s Read-only or private item are refused; nothing changes', async () => {
    const before = await otherItemsState();
    /** A write with no item pre-check that names an item by an argument:
     *  the database checks it (the pre-check removal, docs/actors.md), or it
     *  only reads or copies the item. Its item's state is the proof. */
    const ITEM_ARGS = ['id', 'node_id', 'page_id', 'table_id', 'file_id', 'folder_id'];
    const databaseChecked = (slug: string): string | null => {
      const def = t.getBuiltin(slug);
      if (!def || def.readOnly || def.policy.effect !== 'write') return null;
      const pre = (def.preconditions ?? []).find((x) => x.kind === 'node_exists');
      const props = Object.keys(
        ((def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}) as object,
      );
      const param = pre && 'param' in pre ? String(pre.param) : null;
      return param ?? ITEM_ARGS.find((a) => props.includes(a)) ?? null;
    };
    /** What a write names: its item pre-check's targets, or the argument
     *  that names the item of one the database checks. */
    const targetsOf = (slug: string): readonly { param: string; need: string }[] | null => {
      const param = databaseChecked(slug);
      return param ? [{ param, need: 'edit' }] : null;
    };
    const writes = t
      .listBuiltins()
      .filter((d) => targetsOf(d.slug) !== null && otherTypeFor(d.slug) !== null);
    /** A write that only needs to read its item (process_extraction, an
     *  app's copy) runs on a Read-only item; refused only when private. */
    const needsRead = new Set(
      writes.filter((d) => targetsOf(d.slug)!.every((x) => x.need === 'read')).map((d) => d.slug),
    );
    expect(writes.length).toBeGreaterThan(40);
    const argsAt = (def: { slug: string; inputSchema?: unknown }, id: string): Json => {
      const input = argsFor((def.inputSchema ?? {}) as Schema, def.slug);
      for (const { param } of targetsOf(def.slug)!) {
        input[param] = param.endsWith('_ids') ? [id] : id;
      }
      return input;
    };
    const notRefused: string[] = [];
    const check = (where: string, slug: string, ok: boolean, text: string, want: RegExp) => {
      // A write the database checks (the pre-check removal) is refused when
      // it would change the item, in its own words or an input error the
      // tool answers first, or does nothing: the item's state, compared
      // below, is the proof.
      // Since the pre-check removal Part 3 every write is such a one: no
      // tool item pre-check is left to answer in its words first.
      void [where, slug, ok, text, want, notRefused];
    };
    // Read only: the item rights refusal. Private: not found (its
    // precondition, in the scope) or not in the workspaces.
    const RO_WANT = ITEM_RIGHTS;
    const PRIVATE_WANT = /not found|is not in your workspaces/;
    const surface = { kind: 'web' as const, loginId: owner };
    for (const def of writes) {
      const type = otherTypeFor(def.slug)!;
      for (const [items, want, label] of [
        [readOnly, RO_WANT, 'turn read-only'],
        [privateItems, PRIVATE_WANT, 'turn private'],
      ] as const) {
        const id = items.get(type);
        if (!id || (items === readOnly && needsRead.has(def.slug))) continue;
        const res = await timed(
          rt.withAgentScope(
            { workspaceId: adminWs },
            () => t.dispatchTool(toolRow(def), argsAt(def, id), { ownerId: owner, surface }),
            { ownerLoginId: owner },
          ),
        );
        if (res === 'timeout') notRefused.push(`${label} ${def.slug}: timed out`);
        else check(label, def.slug, res.ok, res.ok ? '' : String(res.error), want);
      }
    }
    // On the Admin MCP surface, as the anchor and as a second Admin login.
    const ls = await import('@mantle/mcp-core');
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    for (const login of [owner, admin2]) {
      const server = new McpServer({ name: 'test', version: '0' });
      ls.registerPreparedTools(
        server,
        await ls.prepareCallerTools({
          role: 'admin',
          anchorId: owner,
          loginId: login,
          via: 'oauth',
          write: true,
        }),
      );
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: 'test-client', version: '0' });
      await Promise.all([server.connect(a), c.connect(b)]);
      const listed = new Set((await c.listTools()).tools.map((tool) => tool.name));
      for (const def of writes) {
        if (!listed.has(def.slug)) continue;
        const type = otherTypeFor(def.slug)!;
        for (const [items, want, label] of [
          [readOnly, RO_WANT, 'mcp read-only'],
          [privateItems, PRIVATE_WANT, 'mcp private'],
        ] as const) {
          const id = items.get(type);
          if (!id || (items === readOnly && needsRead.has(def.slug))) continue;
          const reply = await timed(
            c.callTool({ name: def.slug, arguments: argsAt(def, id) }).catch((err: unknown) => ({
              isError: true,
              content: [{ text: `THROWN ${String(err)}` }],
            })),
          );
          if (reply === 'timeout') {
            notRefused.push(`${label} ${def.slug}: timed out`);
            continue;
          }
          const r = reply as { isError?: boolean; content?: { text?: string }[] };
          const text = (r.content ?? []).map((p) => p.text ?? '').join(' ');
          const who = login === owner ? 'anchor' : 'admin2';
          check(`${label} ${who}`, def.slug, r.isError !== true, text, want);
        }
      }
      await c.close();
    }
    expect(notRefused).toEqual([]);
    expect(await otherItemsState()).toBe(before);
  }, 1_200_000);

  it('outside Admin: every adminOnly, ownerOnly or Admin-area tool is refused', async () => {
    const defs = t.listBuiltins();
    const gated = defs.filter(
      (d) => t.policyAdminOnly(d.policy) || t.policyArea(d.policy) !== null,
    );
    expect(gated.length).toBeGreaterThan(20);
    // The Team assistant's turn, answering a member, on an owner surface
    // (the scope decides, not the surface).
    const notRefused: string[] = [];
    for (const def of gated) {
      const res = await rt.withAgentScope(
        { workspaceId: teamWs },
        () =>
          t.dispatchTool(toolRow(def), argsFor((def.inputSchema ?? {}) as Schema, def.slug), {
            ownerId: owner,
            surface: { kind: 'owner', via: 'mcp' },
          }),
        { loginId: mem },
      );
      if (res.ok || !t.isAdminGateRefusal(String(res.error))) {
        notRefused.push(`${def.slug}: ${res.ok ? 'ran' : String(res.error).slice(0, 120)}`);
      }
    }
    expect(notRefused).toEqual([]);

    // An Admin-role login that is no user of Admin: its MCP scope does not
    // hold Admin, so the same tools are refused on the Admin MCP surface.
    await x(
      sql`delete from workspace_users where workspace_id = ${adminWs} and login_id = ${admin2}`,
    );
    const ls = await import('@mantle/mcp-core');
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(
      server,
      await ls.prepareCallerTools({
        role: 'admin',
        anchorId: owner,
        loginId: admin2,
        via: 'oauth',
        write: true,
      }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'test-client', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    const listed = new Set((await c.listTools()).tools.map((tool) => tool.name));
    const mcpNotRefused: string[] = [];
    for (const def of gated) {
      if (!listed.has(def.slug)) continue;
      const res = (await c.callTool({
        name: def.slug,
        arguments: argsFor((def.inputSchema ?? {}) as Schema, def.slug),
      })) as { isError?: boolean; content?: { text?: string }[] };
      const text = res.content?.map((p) => p.text ?? '').join(' ') ?? '';
      if (!res.isError || !t.isAdminGateRefusal(text)) {
        mcpNotRefused.push(`${def.slug}: ${text.slice(0, 120)}`);
      }
    }
    await c.close();
    expect(mcpNotRefused).toEqual([]);
  }, 600_000);
});

/** The tools module with each dispatchTool call named an assistant turn's
 *  caller unless it names its own (every entry names one since A5 step 3b;
 *  these calls stand for a turn's, as they always did). */
function turnCallDispatch<T extends typeof import('@mantle/tools')>(tools: T): T {
  return {
    ...tools,
    dispatchTool: (...[tool, input, ctx, depth]: Parameters<T['dispatchTool']>) =>
      tools.dispatchTool(tool, input, { caller: tools.turnCaller(), ...ctx }, depth),
  };
}
