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
 *    area, is refused before it runs.
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
  /permission denied|row-level security|42501|turn scope|outside its turn scope|has no viewer level|only outside a viewer scope|already inside|needs an allowlisted reason|scope-lost/i;
/** The database's item-workspace refusals (allowed: the turn's scope says no). */
const ITEM_WS =
  /not allowed to (add items to that folder|delete this item|move this item)|placing this app adds a workspace you do not moderate|a node's login can only be your own/i;

/** Tools that take a long road outside the box even when stubbed. */
const CALL_TIMEOUT_MS = 30_000;

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
  [/^folder|^tree_folder/, 'folder'],
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
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const admin2 = randomUUID(); // an Admin-role login, later no user of Admin
  const mem = randomUUID();
  const tag = `w7a${randomUUID().slice(0, 6)}`;
  let adminWs = '';
  let teamWs = '';
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
      if (key === 'parent' || (/path/i.test(key) && /folder/.test(slug))) return 'files';
      if (/path/i.test(key)) return `files/${tag}-${slug}.txt`;
      if (/email|^to$|address/i.test(key)) return 'nobody@example.invalid';
      if (s?.format === 'date-time' || /(_at|At|date|since|until|start|end)$/i.test(key)) {
        return new Date().toISOString();
      }
      if (/slug/i.test(key)) return `${tag}-${slug.replace(/_/g, '-')}`;
      if (/sql|query/i.test(key)) return 'select 1';
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
    delete process.env.MANTLE_ADMIN_READS;
    // Nothing leaves the test: every outbound request answers 503.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the W7a sweep', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    rt = await import('@mantle/runtime/agent');
    const hb = await import('@mantle/runtime/heartbeats');
    hb.registerHeartbeatTools();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Owner'),
      (${admin2}, ${email('admin2')}, 'x', false, 'admin', 'Second Admin'),
      (${mem}, ${email('mem')}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const ws = await x<{ id: string; admin: boolean; key: string | null }>(sql`
      select id::text, is_admin as admin, bridge_key as key from workspaces
       where owner_id = ${owner} and archived_at is null`);
    adminWs = ws.find((w) => w.admin)!.id;
    teamWs = ws.find((w) => w.key === 'team')!.id;
    const files = await import('@mantle/files');
    await m.asSystem(() => files.ensureFilesRootBranch(owner));
  }, 240_000);

  afterAll(async () => {
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
          { audience: 'admin', workspaceId: adminWs },
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
      if (res === 'timeout') continue;
      if (res.ok) ran += 1;
      else errs.push(`${def.slug}: ${String(res.error).slice(0, 100)}`);
      if (!res.ok) {
        const e = String(res.error);
        if ((BAD.test(e) && !ITEM_WS.test(e)) || e.startsWith('THROWN')) {
          bad.push(`${def.slug}: ${e.slice(0, 240)}`);
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

  it('every tool of the Admin MCP surface: no permission error, no protocol error', async () => {
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
        loginId: owner,
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
        await timed(
          c
            .callTool({ name: tool.slug, arguments: argsFor(tool.schema, tool.slug) })
            .catch((err: unknown) => {
              thrown = err;
            }),
        );
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
  }, 1_200_000);

  it('outside Admin: every adminOnly, ownerOnly or Admin-area tool is refused', async () => {
    const defs = t.listBuiltins();
    const gated = defs.filter(
      (d) => d.ownerOnly || t.ADMIN_ONLY_TOOL_SLUGS.has(d.slug) || t.toolAdminArea(d.slug) !== null,
    );
    expect(gated.length).toBeGreaterThan(20);
    // The Team assistant's turn, answering a member, on an owner surface
    // (the scope decides, not the surface).
    const notRefused: string[] = [];
    for (const def of gated) {
      const res = await rt.withAgentScope(
        { audience: 'team', workspaceId: teamWs },
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
