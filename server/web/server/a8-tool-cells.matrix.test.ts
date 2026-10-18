/**
 * The A8 tool cells (plan v3.2 S11a; section 5 item 2): every tool whose
 * policy declares a matrix action, through a turn (dispatchTool in the
 * assistant's turn scope, as the turn's tool loop calls it) and the one MCP
 * surface (an OAuth connection for the login: prepareCallerTools), in check
 * modes warn and on (the actor check and the edit check both, as a box runs
 * them: warn and warn, on and on), each cell the guide oracle's answer for
 * the action the tool declares. The cells are generated from the declarations alone
 * (@mantle/db matrix/test-support/a8-tool-cells.ts): a pairwise pick salted
 * by each tool's name, one allowed cell of each tool whatever the pick, and
 * the member-negative cells of every write. The tool list is the coverage
 * test's (a8-tools.list.ts).
 * The fixture is the SQL grid's (a8-grid.ts), seeded once; a write cell gets
 * a fresh item of its kind and placement; a tool that works on what is
 * inside an item (blocks, rows, columns, tabs, snapshots, a file's bytes, a
 * Files folder, an app's open data) gets, for each cell, a fresh item with
 * that content seeded (@mantle/db matrix/test-support/a8-tool-content.ts).
 *
 * A cell passes on the right outcome: allowed answers ok (a delete removes
 * the item, a create makes one); refused answers no ok, changes no row and
 * is no crash, and, for a caller that does not read the item, answers what a
 * random uuid gets (byte for byte, the id aside); a write's refusal makes
 * no node either. An allowed cell of a tool that needs a model or the
 * outside (stubbed: cost safety) is counted and not run; its refused cells
 * run. Every other tool runs an allowed cell in each mode, and one passes.
 * Each cell's actor misses are its own failure. Known failures are listed
 * in a8-known-failures.ts by name (`tool:<slug> <way in> <cell>`).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test:matrix
 */
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GuideRole } from '@mantle/db/matrix/guide-oracle';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));
// The app's own SQLite (the fixture's app has none), as the surface cells.
vi.mock('@mantle/content/app-broker', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appDbQuery: vi.fn(async () => ({ rows: [] })),
  appDbExec: vi.fn(async () => ({ changes: 1 })),
}));
// The object store is outside the box: an app build puts its bundle there
// (app_build, app_import). Content-addressed keys, nothing kept.
vi.mock('@mantle/storage/write', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  putContent: async (body: Buffer) => {
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(body).digest('hex');
    return { key: `test/${sha256}`, sha256, size: body.length, deduped: false };
  },
}));

/** The time the tool cells may take, both modes (the budget cell): about
 *  three times the 70 s they take on the workstation. */
const A8_TOOL_TIME_CEILING_MS = 210_000;

type Reply = { isError?: boolean; content?: { text?: string }[] };
const text = (r: unknown) =>
  ((r as Reply | null)?.content ?? []).map((p) => p.text ?? '').join(' ');

/** Per-tool arguments beside the item's (the rest are the schema's own
 *  required ones, filled by type). */
type Ctx = {
  tag: string;
  itemId: string;
  /** A Recall map's version (its edits send the one they read). */
  version: number;
};
const fresh = (c: Ctx) => `${c.tag} ${randomUUID().slice(0, 8)}`;
const INPUT: Readonly<Record<string, (c: Ctx) => Record<string, unknown>>> = {
  file_create: (c) => ({ filename: `${fresh(c).replace(' ', '-')}.txt`, content: 'a8' }),
  file_upload: (c) => ({ filename: `${fresh(c).replace(' ', '-')}.txt`, content_text: 'a8' }),
  folder_create: (c) => ({ slug: fresh(c).replace(' ', '-') }),
  recall_map_create: (c) => ({ title: `${c.tag} made`, enter_when: 'an A8 create' }),
  // The turn's agent may delegate to it (turnCall's agent context).
  invoke_agent: (c) => ({ agent_slug: `${c.tag}-delegate`, prompt: 'an A8 delegation' }),
  // A prompt the schema takes (three characters at least): the refused cells
  // reach the item read. The model stays stubbed.
  generate_image: () => ({ prompt: 'an A8 image' }),
  event_update: (c) => ({ title: `${c.tag} edited` }),
  task_update: (c) => ({ title: `${c.tag} edited` }),
  note_update: (c) => ({ title: `${c.tag} edited` }),
  formula_update: (c) => ({ title: `${c.tag} edited` }),
  page_update: (c) => ({ title: `${c.tag} edited` }),
  table_update: (c) => ({ title: `${c.tag} edited` }),
  app_update: (c) => ({ name: `${c.tag} edited` }),
  recall_map_update: (c) => ({ title: `${c.tag} edited`, version: c.version }),
  page_update_draft: () => ({ markdown: 'a8 draft' }),
  app_db_query: () => ({ sql: 'select 1' }),
  recall_card_put: (c) => ({ title: 'A8', body: 'a8', version: c.version }),
  recall_card_delete: (c) => ({ card: 'card', version: c.version }),
  recall_prompt_confirm: (c) => ({ card: 'card', confirm: true, version: c.version }),
  recall_card_set_slug: (c) => ({ card: 'card', slug: 'card-b', version: c.version }),
  recall_map_set_slug: (c) => ({
    slug: `${c.tag}-${randomUUID().slice(0, 6)}`,
    version: c.version,
  }),
  recall_cards_reorder: (c) => ({ slugs: ['card'], version: c.version }),
  // A fresh map is published (recall_maps.published defaults to true): the
  // cell unpublishes it, the same tool and right, so the change shows.
  recall_map_publish: (c) => ({ published: false, version: c.version }),
  tree_folder_create: (c) => ({ kind: 'notes', name: fresh(c) }),
  tree_folder_update: (c) => ({ kind: 'notes', name: fresh(c) }),
  tree_folder_delete: () => ({ kind: 'notes' }),
  page_create: (c) => ({ title: `${c.tag} made` }),
  page_from_notes: (c) => ({ title: `${c.tag} made`, supersede_source: false }),
  page_from_note: () => ({ supersede_source: false }),
  app_duplicate: () => ({ with_data: false }),
  app_file_write: () => ({ path: 'a8.txt', content: 'a8' }),
  app_file_delete: () => ({ path: 'a8.txt' }),
  app_source_set: () => ({
    entry: 'index.tsx',
    files: { 'index.tsx': 'export default function A() { return null; }' },
  }),
  app_db_schema_set: () => ({ schema_sql: 'create table if not exists a8 (v integer)' }),
  app_db_seed: () => ({ table: 'a8', rows: [{ v: 1 }] }),
  app_table_export_set: () => ({ table: 'a8' }),
  table_rows_add: () => ({ rows: [{}] }),
  table_column_add: (c) => ({ name: `${c.tag}`, type: 'text' }),
  email_page: () => ({ to: 'a8@example.invalid' }),
  peer_file_copy: () => ({ peer: 'a8-none' }),
  file_set_indexing: () => ({ mode: 'metadata' }),
};

/** The allowed cells that need what the matrix cannot hold: counted, not
 *  run (their refused cells run). The content an item holds is seeded
 *  (a8-tool-content.ts); what is left is outside the box. */
const ALLOW_NEEDS: Readonly<Record<string, string>> = {
  peer_file_copy: 'a federated peer brain (outside the box)',
  sandbox_import: 'a sandbox (sandboxd, outside the box)',
  sandbox_create: 'a sandbox (sandboxd, outside the box)',
};

/** The app data tools act for a login's own MCP connection only (tools
 *  builtins-app-data.ts appDataCaller): a turn is refused whatever the item
 *  (a deny the oracle cannot see: the way in, not the item). */
const MCP_CONNECTION_ONLY: Readonly<Record<string, string>> = {
  app_data_schema: 'the app data tools act for a login’s own MCP connection only',
  app_data_query: 'the app data tools act for a login’s own MCP connection only',
  app_data_write: 'the app data tools act for a login’s own MCP connection only',
};

/** The tools whose every allowed cell is a known failure today (the finding
 *  names it, a8-known-failures.ts): their allowed cells run and fail as
 *  listed. A tool leaves this list when its finding is fixed. */
const ALLOWED_KNOWN_ONLY: Readonly<Record<string, string>> = {
  page_move: 'S11a-5',
  tree_item_move: 'S11a-5',
};

/** The tools that make a new app: a new app needs manage of its create
 *  home, and a turn's create home is the turn's workspace (the oracle
 *  answers the source's read only). A turn whose login is no Moderator of
 *  its workspace is refused whatever the item. */
const NEW_APP_HOME: Readonly<Record<string, string>> = {
  app_import: 'a new app needs manage of its create home: the turn’s workspace',
  app_duplicate: 'a new app needs manage of its create home: the turn’s workspace',
};

/** The create cells that name a Files folder (the Files F folder: the
 *  branch kind's F folder is in the notes tree). */
const FILES_BRANCH_CREATE: ReadonlySet<string> = new Set(['folder_create', 'folder_copy']);

/** The arguments that name their folder by its title, not its id or path:
 *  a Recall folder by its crumbs. */
const BY_TITLE: Readonly<Record<string, string>> = { recall_map_create: 'folder' };

/** The allowed edits whose change the probe cannot see (the item's row,
 *  its content, a seeded item's content: a8_probe, a8ContentProbe): they
 *  pass on their ok alone, each with why. */
const PROBE_BLIND: Readonly<Record<string, string>> = {
  process_extraction:
    'it re-signals the extractor (pg_notify node_ingested): no row of the item changes',
};

/** The tools the MCP surface lists for an Admin user only (a deny the
 *  oracle cannot see: the surface, not the item). */
const MCP_ADMIN_ONLY: Readonly<Record<string, string>> = {
  process_extraction: 'not on the MCP surface of a login outside Admin',
};

describe.skipIf(!DB_URL)(
  'A8 tool cells: every tool’s declared action is the oracle’s answer',
  () => {
    type Ts = typeof import('@mantle/db/test-support');
    let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
    let raw: ReturnType<typeof postgres>;
    let m: typeof import('@mantle/db');
    let t: typeof import('@mantle/tools');
    let ls: typeof import('@mantle/mcp-core');
    let rt: typeof import('@mantle/runtime/agent');
    let g: typeof import('@mantle/db/matrix/a8-grid');
    let o: typeof import('@mantle/db/matrix/guide-oracle');
    let tc: typeof import('@mantle/db/matrix/a8-tool-cells');
    let tc2: typeof import('@mantle/db/matrix/a8-tool-content');
    let contentDeps: import('@mantle/db/matrix/a8-tool-content').A8ContentDeps;
    let actorMode: typeof import('../../../packages/db/src/actor');
    let fx: import('@mantle/db/matrix/a8-grid').A8Fixture;
    let dir = '';
    const agentOf: Record<string, string> = {};
    const clients = new Map<GuideRole, { call: (n: string, a: unknown) => Promise<Reply> }>();
    const closers: (() => Promise<void>)[] = [];

    beforeAll(async () => {
      const ts: Ts = await import('@mantle/db/test-support');
      scratch = await ts.createMigratedScratchDatabase(DB_URL!);
      dir = await mkdtemp(path.join(tmpdir(), 'a8-tools-'));
      process.env.DATABASE_URL = scratch.url;
      process.env.TABLE_DB_DIR = path.join(dir, 'tables');
      process.env.APP_DB_DIR = path.join(dir, 'apps');
      process.env.FILES_DIR = path.join(dir, 'files');
      process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
      process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
      process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
      process.env.SESSION_SECRET = 'a8-tool-cells-secret-at-least-32-characters';
      delete process.env.MANTLE_DETACHED_DEV;
      // The app build reads the app runtime's exports map (none on a box
      // that never built the runtime): a stub of its own.
      await mkdir(path.join(dir, 'runtime'), { recursive: true });
      await writeFile(
        path.join(dir, 'runtime', 'manifest.json'),
        JSON.stringify({
          exports: {
            '@host': ['host'],
            react: ['default', 'useState', 'useEffect', 'useMemo', 'useRef', 'useCallback'],
            'react/jsx-runtime': ['jsx', 'jsxs', 'Fragment'],
          },
        }),
      );
      process.env.MANTLE_APP_RUNTIME_MANIFEST = path.join(dir, 'runtime', 'manifest.json');
      // Cost safety: nothing reaches out, and every model is fake.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('offline in the A8 tool cells', { status: 503 })),
      );
      m = await import('@mantle/db');
      t = await import('@mantle/tools');
      ls = await import('@mantle/mcp-core');
      rt = await import('@mantle/runtime/agent');
      g = await import('@mantle/db/matrix/a8-grid');
      o = await import('@mantle/db/matrix/guide-oracle');
      tc = await import('@mantle/db/matrix/a8-tool-cells');
      tc2 = await import('@mantle/db/matrix/a8-tool-content');
      const tdb = await import('@mantle/tabledb');
      const { writeDocFile } = await import('@mantle/tabledb/write');
      const { writeAppPackage } = await import('@mantle/content/app-package');
      const { appDbSeedRows } = await import('@mantle/content/app-broker');
      contentDeps = {
        filesRoot: process.env.MANTLE_FILES_ROOT!,
        writeWorkbook: (rel, wb, meta) =>
          writeDocFile(tdb.resolveStoragePath(rel), wb as never, { ...meta, fts: true }),
        snapshotWorkbook: (rel, srel) => {
          tdb.snapshotFile(tdb.resolveStoragePath(rel), tdb.resolveStoragePath(srel));
          return statSync(tdb.resolveStoragePath(srel)).size;
        },
        tableFile: (rel) => tdb.resolveStoragePath(rel),
        engineVersion: tdb.ENGINE_VERSION,
        writeAppPackage: async (appId, dest) => {
          await m.runAsSystem('test:a8-tool-content', () =>
            writeAppPackage(fx.owner, appId, dest, { withData: false }),
          );
        },
        appDbFile: (appId) => path.join(process.env.APP_DB_DIR!, fx.owner, `${appId}.sqlite`),
        seedAppDb: async (appId, schema) => {
          await m.runAsSystem('test:a8-tool-content', () =>
            appDbSeedRows(fx.owner, appId, 'a8', [{ v: 1 }], {}, schema),
          );
        },
      };
      actorMode = await import('../../../packages/db/src/actor');
      raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
      fx = await g.buildA8Fixture(raw);
      await g.installProbe(raw);
      await tc2.makeA8DropFolder(raw, fx);
      await raw`select mantle_set_actor_check('off', 50, 'test')`;
      await m.asSystem(() => t.seedBuiltinTools(fx.owner), 'test');
      for (const [name, wsId] of Object.entries(fx.ws)) {
        const id = randomUUID();
        agentOf[wsId] = id;
        await raw`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
        values (${id}, ${fx.owner}, ${`${fx.tag}-${name}`}, ${name}, 'fake/model', 'p',
                ${name === 'admin' ? 'assistant' : 'responder'}, ${wsId})`;
      }
      // invoke_agent's target: an agent every turn's agent may delegate to.
      await raw`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
        values (${randomUUID()}, ${fx.owner}, ${`${fx.tag}-delegate`}, 'delegate', 'fake/model',
                'p', 'responder', ${fx.ws.admin})`;
      m.takeActorMisses();
    }, 300_000);

    afterAll(async () => {
      for (const close of closers) await close().catch(() => {});
      delete process.env.MANTLE_ACTOR_CHECK;
      vi.unstubAllGlobals();
      const bridge = (globalThis as { __mantleRealtime?: { stop?: (() => Promise<void>) | null } })
        .__mantleRealtime;
      await bridge?.stop?.();
      await raw?.end();
      await m?.closeDb();
      await scratch?.drop();
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    const isAdminUser = (role: GuideRole) => role === 'owner' || role === 'admin';
    const loginActor = (role: GuideRole) =>
      m.loginActor(fx.logins[role], role === 'owner' ? 'owner' : 'rw');
    const turnWs = (role: GuideRole) => {
      const w = o.TURN_WORKSPACE[role];
      return w === 'private' ? fx.privateWs[role]! : fx.ws[w];
    };

    const toolRows = new Map<string, Awaited<ReturnType<typeof t.resolveTool>>>();
    const toolRow = async (slug: string) => {
      if (!toolRows.has(slug)) {
        toolRows.set(slug, await m.asSystem(() => t.resolveTool(fx.owner, slug), 'test'));
      }
      const row = toolRows.get(slug);
      if (!row) throw new Error(`no tool ${slug}`);
      return row;
    };

    type Outcome = import('@mantle/db/matrix/a8-tool-cells').A8ToolOutcome;
    const guard = async (fn: () => Promise<Outcome>): Promise<Outcome> => {
      try {
        return await fn();
      } catch (err) {
        return { ok: false, thrown: true, text: `THROWN ${(err as Error).message}` };
      }
    };

    /** The turn's call: dispatchTool in the assistant's turn scope. */
    const turnCall = (role: GuideRole, slug: string, input: Record<string, unknown>) =>
      guard(async () => {
        const ws = turnWs(role);
        // Resolved before the turn's scope, as the tool loop has its rows.
        const row = await toolRow(slug);
        const res = await m.runAsActor(loginActor(role), () =>
          rt.withAgentScope(
            { id: agentOf[ws], ownerId: fx.owner, workspaceId: ws },
            async () =>
              t.dispatchTool(row, input, {
                ownerId: fx.owner,
                surface: { kind: 'web', loginId: fx.logins[role] } as never,
                caller: t.turnCaller() as never,
                // The turn's agent, as the tool loop gives it (invoke_agent
                // reads it): it may delegate to the test's one target.
                agent: {
                  slug: `${fx.tag}-${o.TURN_WORKSPACE[role]}`,
                  depth: 1,
                  delegateTo: [`${fx.tag}-delegate`],
                },
              }),
            { loginId: fx.logins[role] },
          ),
        );
        return {
          ok: res.ok,
          text: res.ok ? JSON.stringify(res.output ?? '') : String(res.error ?? ''),
        };
      });

    /** The MCP surface's call for the login (one client per login). */
    const mcpCall = (role: GuideRole, slug: string, input: Record<string, unknown>) =>
      guard(async () => {
        let client = clients.get(role);
        if (!client) {
          const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
          const { Client } = await import('@modelcontextprotocol/client');
          const server = new McpServer({ name: 'a8-tools', version: '0' });
          ls.registerPreparedTools(
            server,
            await ls.prepareCallerTools({
              role: isAdminUser(role) ? 'admin' : 'member',
              anchorId: fx.owner,
              loginId: fx.logins[role],
              via: 'oauth',
              write: true,
              oauthClientId: 'a8',
            }),
          );
          const [a, b] = InMemoryTransport.createLinkedPair();
          const c = new Client({ name: fx.tag, version: '0' });
          await Promise.all([server.connect(a), c.connect(b)]);
          closers.push(() => c.close());
          client = {
            call: async (name, args) =>
              (await c.callTool({ name, arguments: args as Record<string, unknown> })) as Reply,
          };
          clients.set(role, client);
        }
        try {
          const r = await m.runAsActor(loginActor(role), () => client!.call(slug, input));
          return { ok: !(r.isError ?? false), text: text(r) };
        } catch (err) {
          const msg = (err as Error).message;
          if (/Tool \S+ not found/.test(msg)) return { ok: false, text: `not listed: ${msg}` };
          throw err;
        }
      });

    it('each tool’s cells, through a turn and the MCP surface, in warn and on', async () => {
      const started = Date.now();
      const { sortFailures } = await import('@mantle/db/matrix/a8-known-failures');
      // The coverage test's list (a8-tools.list.ts): the same plan.
      const { a8AllTools } = await import('./a8-tools.list');
      const decls = new Map(a8AllTools().map((d) => [d.slug, tc.a8ToolDecl(d)]));
      const plan = tc.a8ToolPlan([...decls.values()]);
      expect(plan.uncovered, 'tools with an action and no cell').toEqual({});

      /** The schema's required arguments, filled by type. */
      const filled = (slug: string, param: string, c: Ctx) => {
        const s = decls.get(slug)!.inputSchema as {
          properties?: Record<string, { type?: string; enum?: unknown[] }>;
          required?: string[];
        };
        const out: Record<string, unknown> = {};
        for (const r of s.required ?? []) {
          if (r === param) continue;
          const p = s.properties?.[r] ?? {};
          out[r] = p.enum?.length
            ? p.enum[0]
            : p.type === 'integer' || p.type === 'number'
              ? 1
              : p.type === 'boolean'
                ? false
                : p.type === 'array'
                  ? []
                  : p.type === 'object'
                    ? {}
                    : `${c.tag} a8`;
        }
        // A call that asks for a confirm sends it (the caller confirmed).
        if (s.properties && 'confirm' in s.properties) out.confirm = true;
        return { ...out, ...(INPUT[slug]?.(c) ?? {}) };
      };
      type Ref = { id: string; path: string; title: string };
      /** The form the argument names its item in (an id, a path, a title). */
      const formOf = (slug: string, param: string, ref: Ref) =>
        param.endsWith('_path') ? ref.path : BY_TITLE[slug] === param ? ref.title : ref.id;
      const argOf = (slug: string, param: string, ref: Ref) => {
        const p = (
          decls.get(slug)!.inputSchema as { properties?: Record<string, { type?: string }> }
        ).properties?.[param];
        if (p?.type === 'array') return [ref.id];
        return formOf(slug, param, ref);
      };
      /** The kind whose folder F a create cell names. */
      const folderKind = (tool: string, kind: string) =>
        kind === 'branch' && FILES_BRANCH_CREATE.has(tool) ? 'file' : kind;

      const rank = { warn: 0, on: 1 } as const;
      expect(
        tc.A8_TOOL_MODES.every((x, i) => i === 0 || rank[x] > rank[tc.A8_TOOL_MODES[i - 1]!]),
      ).toBe(true);
      const lines: string[] = [];
      const unexpected: string[] = [];
      const fixed: string[] = [];
      const skipped: Record<string, number> = {};
      const na: Record<string, number> = {};
      const narrowed: Record<string, number> = {};
      /** Each tool's allowed cells run and passed, by mode. */
      const allowedRuns = new Map<string, { ran: number; passed: number }>();
      let total = 0;
      for (const mode of tc.A8_TOOL_MODES) {
        // Both checks in the mode, as every box runs them (warn and warn, on
        // and on): the edit check is the database's refusal of an item edit
        // the scope may not make.
        await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
        await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
        process.env.MANTLE_ACTOR_CHECK = mode;
        actorMode.noteBoxActorCheckMode(mode);
        expect(m.actorCheckMode()).toBe(mode);
        const modeStarted = Date.now();
        const failures = new Map<string, string>();
        for (const cell of plan.cells) {
          const decl = decls.get(cell.tool)!;
          const role = cell.role!;
          for (const { surface } of tc.A8_TOOL_SURFACES) {
            const name = tc.a8ToolCellName(cell, surface);
            if (surface === 'web-turn' && decl.mcpOnly) {
              na[`${surface}: no tool row (MCP only)`] =
                (na[`${surface}: no tool row (MCP only)`] ?? 0) + 1;
              continue;
            }
            const why =
              tc.a8ToolNarrow(decl, surface, role) ??
              (surface === 'mcp-oauth' && !isAdminUser(role) ? MCP_ADMIN_ONLY[cell.tool] : null) ??
              (surface === 'web-turn' ? MCP_CONNECTION_ONLY[cell.tool] : null) ??
              (surface === 'web-turn' && !fx.scope[role].mod.includes(turnWs(role))
                ? NEW_APP_HOME[cell.tool]
                : null) ??
              null;
            const oracle = tc.a8ToolWant(cell, surface);
            if ('na' in oracle) {
              na[`${surface}: ${oracle.na}`] = (na[`${surface}: ${oracle.na}`] ?? 0) + 1;
              continue;
            }
            const want = (why ? { allow: false, why } : oracle) as
              { allow: true } | { allow: false; why: string };
            if (why) narrowed[`${surface}: ${why}`] = (narrowed[`${surface}: ${why}`] ?? 0) + 1;
            if (want.allow && (decl.stubbed || ALLOW_NEEDS[cell.tool])) {
              const k = decl.stubbed
                ? 'an allowed call needs a model or the outside (stubbed)'
                : `an allowed call needs ${ALLOW_NEEDS[cell.tool]}`;
              skipped[k] = (skipped[k] ?? 0) + 1;
              continue;
            }
            total++;
            const create = cell.action === 'create';
            const reads = ['read', 'list', 'search'].includes(cell.action);
            const edits = cell.action === 'edit' || cell.action === 'editDraft';
            // A copy's destination cell: the source an item the caller
            // reads (seeded where the tool needs content), the item the
            // folder the copy is made in.
            const source = cell.source
              ? await (async () => {
                  const placement = tc.a8ToolSourcePlacement(cell, surface);
                  const s = await tc2.seedA8ToolItem(raw, fx, contentDeps, { ...cell, placement });
                  const it = s ? s.item : fx.items[cell.kind]![placement]!;
                  return {
                    input: s?.input ?? {},
                    ref: { id: it.id, path: it.parentPath, title: it.title },
                  };
                })()
              : null;
            const seeded = source ? null : await tc2.seedA8ToolItem(raw, fx, contentDeps, cell);
            const folder = fx.folders[folderKind(cell.tool, cell.kind)]!;
            const item = seeded
              ? seeded.item
              : create
                ? { id: folder.id, title: folder.title, parentPath: folder.path }
                : reads
                  ? fx.items[cell.kind]![cell.placement]!
                  : await g.makeA8Item(raw, fx, cell.kind, cell.placement);
            const ref: Ref = {
              id: item.id,
              path: create ? folder.path : item.parentPath,
              title: item.title,
            };
            /** The brain's nodes (of the kind, or all): a refused write
             *  makes none. */
            const nodeCount = async (kind?: string) =>
              String(
                (
                  await raw<{ n: number }[]>`select count(*)::int as n from nodes
                     where owner_id = ${fx.owner} and (${kind ?? null}::text is null
                                                       or type = ${kind ?? null})`
                )[0]!.n,
              );
            const probe = async () =>
              create
                ? await nodeCount(cell.kind)
                : await (async () => {
                    const p = (
                      await raw<{ p: string }[]>`select a8_probe(${item.id}::uuid) as p`
                    )[0]!.p;
                    // A seeded item, and any item an edit cell changes: what
                    // its content holds, too (a8ContentProbe: its row, its
                    // table and app rows, snapshots, cards, files on disk),
                    // so an allowed edit's change shows.
                    const held =
                      p === 'gone' || (!seeded && !edits)
                        ? p
                        : `${p}|${await tc2.a8ContentProbe(raw, item.id, contentDeps)}`;
                    // A write that declares a read (a copy, an import, an
                    // export): no node made either.
                    return reads && cell.effect === 'write' ? `${held}#${await nodeCount()}` : held;
                  })();
            const ctx: Ctx = {
              tag: fx.tag,
              itemId: item.id,
              version:
                cell.kind === 'recall'
                  ? ((
                      await raw<{ v: number }[]>`select version as v from recall_maps
                         where id = ${item.id}::uuid`
                    )[0]?.v ?? 0)
                  : 0,
            };
            const input = {
              ...filled(cell.tool, cell.param, ctx),
              ...(seeded?.input ?? source?.input ?? {}),
              ...(source && cell.source
                ? { [cell.source]: argOf(cell.tool, cell.source, source.ref) }
                : {}),
              [cell.param]: argOf(cell.tool, cell.param, ref),
            };
            const call = surface === 'web-turn' ? turnCall : mcpCall;
            const before = await probe();
            m.takeActorMisses();
            const out = await call(role, cell.tool, input);
            const misses = m.takeActorMisses();
            const after = await probe();
            let random: { out: Outcome; id: string } | null = null;
            if (!want.allow && !tc.a8ToolReads(cell, surface)) {
              const id = randomUUID();
              const rref: Ref = {
                id,
                path: `${fx.kindRootPath[folderKind(cell.tool, cell.kind)]}.zq${id.slice(0, 8)}`,
                title: `zq${id.slice(0, 8)}`,
              };
              random = {
                id: formOf(cell.tool, cell.param, rref),
                out: await call(role, cell.tool, {
                  ...input,
                  [cell.param]: argOf(cell.tool, cell.param, rref),
                }),
              };
              m.takeActorMisses();
            }
            const fail =
              tc.judgeA8ToolCell({
                cell,
                want,
                out,
                before,
                after,
                item: { id: formOf(cell.tool, cell.param, ref), title: item.title },
                random,
                ...(PROBE_BLIND[cell.tool] ? { blind: PROBE_BLIND[cell.tool] } : {}),
              }) ?? (misses.length ? `actor miss: ${JSON.stringify(misses).slice(0, 160)}` : null);
            if (fail) failures.set(name, fail);
            if (want.allow) {
              const k = `${cell.tool} ${mode}`;
              const r = allowedRuns.get(k) ?? { ran: 0, passed: 0 };
              r.ran++;
              if (!fail) r.passed++;
              allowedRuns.set(k, r);
            }
          }
        }
        const sorted = sortFailures(failures, false, mode, true);
        unexpected.push(...sorted.unexpected.map((u) => `[check ${mode}] ${u}`));
        fixed.push(...sorted.fixed);
        lines.push(
          `A8 tool cells, check ${mode}: ${plan.cells.length} cells in ` +
            `${((Date.now() - modeStarted) / 1000).toFixed(1)} s, ${failures.size} fail ` +
            `(${failures.size - sorted.unexpected.length} known)`,
          ...[...failures].map(([n, r]) => `  FAIL ${n}: ${r}`),
        );
      }
      const elapsed = Date.now() - started;
      console.log(
        [
          `A8 tool cells: ${plan.cells.length} cells of ${plan.covered.length} tools, ${total} runs ` +
            `over ${tc.A8_TOOL_MODES.length} check modes in ${(elapsed / 1000).toFixed(1)} s`,
          ...Object.entries(na).map(([why, n]) => `  n/a ${n}: ${why}`),
          ...Object.entries(narrowed).map(([why, n]) => `  narrowed ${n}: ${why}`),
          ...Object.entries(skipped).map(([why, n]) => `  not run ${n}: ${why}`),
          ...lines,
        ].join('\n'),
      );
      expect(unexpected, 'tool cells that fail and are not known failures').toEqual([]);
      // Every tool's own work runs: an allowed cell in each mode, and one
      // passes (but a tool whose allowed call needs a model, the outside or
      // a peer: counted in NOT_RUN).
      const noAllowed = plan.covered.flatMap((slug) => {
        const d = decls.get(slug)!;
        if (d.stubbed || ALLOW_NEEDS[slug]) return [];
        return tc.A8_TOOL_MODES.flatMap((mode) => {
          const r = allowedRuns.get(`${slug} ${mode}`);
          if (!r?.ran) return [`${slug} (check ${mode}): no allowed cell ran`];
          if (!r.passed && !ALLOWED_KNOWN_ONLY[slug]) {
            return [`${slug} (check ${mode}): no allowed cell passed`];
          }
          if (r.passed && ALLOWED_KNOWN_ONLY[slug]) {
            return [
              `${slug} (check ${mode}): an allowed cell passes: take it off ALLOWED_KNOWN_ONLY`,
            ];
          }
          return [];
        });
      });
      expect(noAllowed, 'tools whose own work never ran or never passed').toEqual([]);
      expect(fixed, 'known failures that pass now: take them off the list').toEqual([]);
      // No cell drops out uncounted: each reason keeps its count (both modes).
      expect(na, 'the tool cells not applicable, by reason').toEqual(NOT_APPLICABLE);
      expect(narrowed, 'the narrowed tool cells, by reason').toEqual(NARROWED);
      expect(skipped, 'the allowed tool cells not run, by reason').toEqual(NOT_RUN);
      // The budget cell: the tool cells stay inside their time.
      expect(elapsed, 'the tool cells took longer than their budget').toBeLessThan(
        A8_TOOL_TIME_CEILING_MS,
      );
    }, 3_600_000);
  },
);

/** The tool cells not applicable, by reason, over both check modes (162
 *  since S11a fix round 4: folder_create and file_upload, MCP only, have
 *  their create cells, 12 cells over both modes each). */
const NOT_APPLICABLE: Readonly<Record<string, number>> = {
  'web-turn: no tool row (MCP only)': 162,
};

/** The narrowed tool cells (a deny the oracle cannot see), by reason. */
const NARROWED: Readonly<Record<string, number>> = {
  'web-turn: the app data tools act for a login’s own MCP connection only': 44,
  'web-turn: an Admin tool: the scope holds no Admin': 70,
  'mcp-oauth: an Admin tool: the scope holds no Admin': 126,
  'web-turn: a new app needs manage of its create home: the turn’s workspace': 6,
  'mcp-oauth: not on the MCP surface of a login outside Admin': 14,
};

/** The allowed tool cells not run, by what they need: the content an item
 *  holds is seeded (a8-tool-content.ts), so what is left is outside the box:
 *  a model, the web or a mail server (cost safety stubs them), a sandbox
 *  (sandboxd) and a federated peer brain. */
const NOT_RUN: Readonly<Record<string, number>> = {
  'an allowed call needs a model or the outside (stubbed)': 68,
  'an allowed call needs a sandbox (sandboxd, outside the box)': 8,
  'an allowed call needs a federated peer brain (outside the box)': 8,
};
