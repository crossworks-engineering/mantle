/**
 * The owner's decisions on the A8 findings (workspaces arch plan v2,
 * section 32), on a migrated scratch database, through the product's own
 * paths. Each cell prints its answer, so a run on the code before the fix
 * records the answers it changes (docs/actors.md, "A8 findings").
 *
 *  F1 (a): a key of a login outside Admin on /api/v1 answers as the v1
 *      route's base route answers that login (D3): every route family, a
 *      read and a write, against the base route with the login's own
 *      session. Contacts, the journal and the table row writes stay Admin
 *      only. The owner's key is unchanged.
 *  F2 (a): a workspace assistant's turn (web, team, Telegram, a run item, a
 *      recipe step) writes with its user's rights in its own workspace: a
 *      create, an edit, a delete and a move of an item the user may change,
 *      and one it may not. A Moderator seat outside the assistant's
 *      workspace never counts. A turn with no user only reads.
 *  Every refusal is words of the mapper, never the database's or the
 *  runtime's own text (Failed query, withSystemTx, SQLSTATE, a stack).
 *
 *  Fix round 1: F1's ?ws= on a v1 create (L3), HEAD and a read-only key;
 *  an Admin user's key on a shared page outside its scope (L4); each turn
 *  enters its scope as the tool loop does for its surface (a web chat names
 *  its signed-in login as an owner surface, never a `loginId` the test
 *  passes); a Moderator seat taken away during a turn (L5); a queued call
 *  of a workspace turn approved by someone else, and an elevated one its
 *  asker never approves (plan section 31). `pnpm test:edit-on` runs this
 *  file with the actor check and the edit check on too.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a8-findings.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ITEM_KINDS } from '@mantle/client-types/kinds';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The connector's remote calls (the approval cells). */
const remote = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../../packages/tools/src/mcp-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpCallRemoteTool: vi.fn(
    async (_o: string, _g: string, _m: unknown, tool: string, input: Record<string, unknown>) => {
      remote.calls.push(`${tool} ${JSON.stringify(input)}`);
      return { text: '{"updated":true}', secrets: [] };
    },
  ),
}));

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

/** The database's or the runtime's own words: never in a reply. */
const RAW =
  /Failed query|withSystemTx|runInSystemTx|withTurnScope|withViewer:|SQLSTATE|DrizzleQueryError|drizzle-orm|permission denied for|violates|duplicate key|does not exist|scoped query ran outside|\n\s+at \S/i;

type Outcome = { ok: boolean; text: string; status?: number };

describe.skipIf(!DB_URL)('A8 findings: the owner’s decisions F1 and F2', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  /** The suite's own actor check mode, put back after (checks on below). */
  let suiteMode: string | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let runRoute: typeof import('./run-route').runRoute;
  let tracing: typeof import('@mantle/tracing');
  let ex: typeof import('../../../packages/runtime/src/agent/tool-loop/execute-call');
  let dir = '';
  const tag = `a8f${randomUUID().slice(0, 6)}`;
  const L = {
    owner: randomUUID(),
    mod: randomUUID(),
    user: randomUUID(),
    // Fix round 1: another plain user of W, and an Admin user in no other
    // workspace.
    user2: randomUUID(),
    admin: randomUUID(),
  };
  type Who = 'mod' | 'user';
  const CONNECTOR = 'mcp_crm_update';
  const ws = { admin: '', W: '', H: '' };
  const agentW = randomUUID();
  const rootOf: Record<string, { id: string; path: string }> = {};
  let folderF = '';
  const keyOf: Partial<Record<'owner' | 'admin' | 'modRead' | Who, string>> = {};
  const recorded: string[] = [];

  const rootPath = (kind: string) =>
    (ITEM_KINDS as Record<string, { tree: { root: string } | null }>)[kind]!.tree!.root;

  /** An item of `kind` at its root, homed in `home`, with `grants`. */
  const makeItem = async (
    kind: string,
    home: string,
    grants: { ws: string; write: boolean }[] = [],
  ): Promise<string> => {
    const id = randomUUID();
    const root = rootOf[kind]!;
    await raw.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${root.id}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${L.owner}, ${kind}, ${`${tag} ${kind} ${id.slice(0, 8)}`},
                       ${root.path}::ltree, ${raw.json({ rank: 'a0' })})`;
    });
    await raw.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${id}, ${home}, true, false)`;
      for (const g of grants) {
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${g.ws}, false, ${g.write})`;
      }
      if (kind === 'page') await tx`insert into pages (node_id, doc) values (${id}, '{"v":0}')`;
      if (kind === 'table') await tx`insert into tables (node_id, data) values (${id}, '{"v":0}')`;
    });
    return id;
  };

  /** What a probe reads of an item: its title, home and place, or gone. */
  const probe = async (id: string) => {
    const [row] = await raw<{ title: string; home: string | null; path: string }[]>`
      select title, home_ws::text as home, path::text as path from nodes where id = ${id}`;
    return row ? `${row.title}|${row.home}|${row.path}` : 'gone';
  };

  const note = (cell: string, out: Outcome) => {
    recorded.push(
      `${cell}: ${out.ok ? 'ok' : 'refused'}${out.status ? ` ${out.status}` : ''} ${out.text.slice(0, 140).replace(/\s+/g, ' ')}`,
    );
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a8-findings-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a8-findings-secret-at-least-32-characters-long';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the A8 findings test', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    rt = await import('@mantle/runtime/agent');
    runRoute = (await import('./run-route')).runRoute;
    tracing = await import('@mantle/tracing');
    ex = await import('../../../packages/runtime/src/agent/tool-loop/execute-call');
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    // The anchor, a Moderator of W and of H (its H seat is outside the
    // assistant's workspace), and a plain user of W.
    for (const [who, id] of Object.entries(L)) {
      const role = who === 'owner' || who === 'admin' ? 'admin' : 'member';
      await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${id}, ${`${tag}-${who}@example.invalid`}, 'x', ${who === 'owner'},
                ${role}, ${who})`;
    }
    await raw`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
              on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    ws.admin = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                    where owner_id = ${L.owner} and is_admin`
    )[0]!.id;
    for (const key of ['W', 'H'] as const) {
      ws[key] = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
          values (${L.owner}, ${`${tag} ${key}`}) returning id::text as id`
      )[0]!.id;
    }
    await raw`delete from workspace_users u using workspaces w
               where w.id = u.workspace_id and not w.is_admin
                 and u.login_id in (${L.mod}, ${L.user}, ${L.user2}, ${L.admin})`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.W}, ${L.mod}, true), (${ws.H}, ${L.mod}, true), (${ws.W}, ${L.user}, false),
      (${ws.W}, ${L.user2}, false)`;
    // The Admin user: in Admin, no Moderator there, in no other workspace.
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.admin}, ${L.admin}, false)
      on conflict (workspace_id, login_id) do update set moderator = false`;
    for (const who of ['mod', 'user', 'user2'] as const) {
      await raw`select mantle_ws_private_workspace(${L[who]}::uuid)`;
    }
    await raw`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
      values (${agentW}, ${L.owner}, ${`${tag}-w`}, 'W', 'fake/model', 'p', 'responder', ${ws.W})`;
    for (const kind of ['note', 'task', 'page', 'table', 'event', 'file']) {
      const p = rootPath(kind);
      await raw`insert into nodes (owner_id, type, title, path)
                select ${L.owner}, 'branch', ${p}, ${p}::ltree
                 where not exists (select 1 from nodes where owner_id = ${L.owner}
                                     and type = 'branch' and path = ${p}::ltree)`;
      rootOf[kind] = {
        id: (
          await raw<{ id: string }[]>`select id::text as id from nodes
            where owner_id = ${L.owner} and type = 'branch' and path = ${p}::ltree`
        )[0]!.id,
        path: p,
      };
    }
    // Folder F of the tasks tree, homed in W.
    folderF = randomUUID();
    await raw.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${rootOf.task!.id}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path)
               values (${folderF}, ${L.owner}, 'branch', ${`${tag} F`},
                       ${`${rootOf.task!.path}.${tag}f`}::ltree)`;
    });
    await raw.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${folderF}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${folderF} and via_folder_id is null`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${folderF}, ${ws.W}, true, false)`;
    });
    await raw`select mantle_set_actor_check('warn', 50, 'test')`;
    await m.asSystem(() => t.seedBuiltinTools(L.owner), 'test');
    // A connector W holds with its Write on (the approval cells): a write
    // that waits for approval (requires_confirm).
    await raw`insert into tool_groups (owner_id, slug, name, tool_slugs, integration, enabled)
      values (${L.owner}, 'crm', 'CRM', ${`{${CONNECTOR}}`}::text[],
              ${raw.json({ mcp: { url: 'https://crm.example.test/mcp' } })}, true)`;
    await raw`insert into tools (owner_id, slug, name, description, input_schema, handler,
                                 requires_confirm, enabled)
      values (${L.owner}, ${CONNECTOR}, 'CRM update', 'Update a CRM record.',
              ${raw.json({ type: 'object', properties: { id: { type: 'string' } } })},
              ${raw.json({ kind: 'mcp', group: 'crm', toolName: 'update' })}, true, true)`;
    await raw`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${ws.W}, 'connector', 'crm', true)`;
    const keys = await import('../lib/access-keys');
    for (const who of ['owner', 'mod', 'user', 'admin', 'modRead'] as const) {
      const login = who === 'modRead' ? L.mod : L[who];
      const minted = await m.asSystem(
        () =>
          keys.mintAccessKey({
            name: `${tag} ${who}`,
            loginId: login,
            access: who === 'modRead' ? 'read' : 'read_write',
            areas: null,
            riskyTools: [],
            expiresAt: new Date(Date.now() + 30 * 86_400_000),
            createdBy: login,
            maxLive: 50,
          }),
        'test',
      );
      keyOf[who] = minted!.key;
    }
    // The tool rows, resolved before any turn scope (a turn never leaves
    // its scope for a test's lookup).
    for (const slug of [
      'task_update',
      'task_delete',
      'task_create',
      'tree_item_move',
      'note_update',
    ]) {
      await toolRow(slug);
    }
    m.takeActorMisses();
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
  }, 300_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    console.log(['A8 findings, each cell’s answer:', ...recorded].join('\n  '));
    vi.unstubAllGlobals();
    const bridge = (globalThis as { __mantleRealtime?: { stop?: (() => Promise<void>) | null } })
      .__mantleRealtime;
    await bridge?.stop?.();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // ── F1: /api/v1 as the base route ──────────────────────────────────────

  const http = async (
    login: string | { key: string },
    method: string,
    p: string,
    body?: unknown,
  ): Promise<Outcome> => {
    const res = await runRoute(login, method, p, body, {
      headers: {
        'x-forwarded-for': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.7`,
      },
    });
    return { ok: res.status < 300, status: res.status, text: (await res.text()).slice(0, 400) };
  };

  it('F1: a member key on /api/v1 answers as the base route answers its login', async () => {
    const failures: string[] = [];
    const now = new Date(Date.now() + 86_400_000).toISOString();
    for (const who of ['mod', 'user'] as const) {
      // Each family: [method, v1 path, base path, body, an item made fresh
      // for each side when the call changes it].
      type Cell = [string, (id: string) => string, (id: string) => string, unknown, string | null];
      const cells: Cell[] = [
        ['GET', () => '/api/v1/notes', () => '/api/notes', undefined, null],
        ['GET', (i) => `/api/v1/notes/${i}`, (i) => `/api/notes/${i}`, undefined, 'note'],
        ['POST', () => '/api/v1/notes', () => '/api/notes', { title: `${tag} made` }, null],
        ['GET', (i) => `/api/v1/nodes/${i}`, (i) => `/api/nodes/${i}`, undefined, 'note'],
        ['GET', () => `/api/v1/search?q=${tag}`, () => `/api/search?q=${tag}`, undefined, null],
        ['GET', () => '/api/v1/tasks', () => '/api/tasks', undefined, null],
        ['POST', () => '/api/v1/tasks', () => '/api/tasks', { title: `${tag} task` }, null],
        ['GET', (i) => `/api/v1/tasks/${i}`, (i) => `/api/tasks/${i}`, undefined, 'task'],
        ['PATCH', (i) => `/api/v1/tasks/${i}`, (i) => `/api/tasks/${i}`, { title: 'x2' }, 'task'],
        ['GET', () => '/api/v1/pages', () => '/api/pages', undefined, null],
        ['POST', () => '/api/v1/pages', () => '/api/pages', { title: `${tag} page` }, null],
        ['GET', (i) => `/api/v1/pages/${i}`, (i) => `/api/pages/${i}`, undefined, 'page'],
        ['PATCH', (i) => `/api/v1/pages/${i}`, (i) => `/api/pages/${i}`, { title: 'p2' }, 'page'],
        ['GET', () => '/api/v1/tables', () => '/api/tables', undefined, null],
        ['GET', (i) => `/api/v1/tables/${i}`, (i) => `/api/tables/${i}`, undefined, 'table'],
        [
          'GET',
          (i) => `/api/v1/tables/${i}/rows`,
          (i) => `/api/tables/${i}/rows`,
          undefined,
          'table',
        ],
        [
          'POST',
          (i) => `/api/v1/tables/${i}/commit`,
          (i) => `/api/tables/${i}/commit`,
          {},
          'table',
        ],
        ['GET', () => '/api/v1/files', () => '/api/files/files', undefined, null],
        ['GET', (i) => `/api/v1/files/${i}`, (i) => `/api/files/files/${i}`, undefined, 'file'],
        ['GET', () => '/api/v1/events', () => '/api/events', undefined, null],
        [
          'POST',
          () => '/api/v1/events',
          () => '/api/events',
          { title: `${tag} event`, startsAt: now },
          null,
        ],
        ['GET', () => '/api/v1/contacts', () => '/api/contacts', undefined, null],
        ['GET', () => '/api/v1/journal', () => '/api/journal', undefined, null],
      ];
      for (const [method, v1, base, body, kind] of cells) {
        // One item each side, homed in W (both logins read it; the
        // Moderator changes it, the plain user may not).
        const viaKey = kind ? await makeItem(kind, ws.W) : '';
        const viaBase = kind ? await makeItem(kind, ws.W) : '';
        const a = await http({ key: keyOf[who]! }, method, v1(viaKey), body);
        const b = await http(L[who], method, base(viaBase), body);
        note(`api-v1 ${who} ${method} ${v1(':id')}`, a);
        note(`base   ${who} ${method} ${base(':id')}`, b);
        if (a.status !== b.status) {
          failures.push(`${who} ${method} ${v1(':id')}: v1 ${a.status}, base ${b.status}`);
        }
        if (method === 'GET' && kind && a.ok && !a.text.includes(viaKey)) {
          failures.push(`${who} GET ${v1(':id')}: the item is not in the answer`);
        }
        if (RAW.test(a.text)) failures.push(`${who} ${method} ${v1(':id')}: raw text`);
      }
      // The table row writes have no base route: Admin users only.
      const table = await makeItem('table', ws.W);
      const rows = await http({ key: keyOf[who]! }, 'POST', `/api/v1/tables/${table}/rows`, {
        rows: [{ Name: 'a' }],
      });
      note(`api-v1 ${who} POST /api/v1/tables/:id/rows`, rows);
      if (rows.status !== 403 || !rows.text.includes('member-login')) {
        failures.push(`${who} POST /api/v1/tables/:id/rows: ${rows.status} ${rows.text}`);
      }
    }
    // A key's own rule on a page's content (a page others read) never tells
    // a member's key about a page it does not read: the same 404 as an id
    // no row has.
    const unread = await makeItem('page', ws.H);
    const doc = { doc: { type: 'doc', content: [] } };
    for (const [cell, id] of [
      ['a page it does not read', unread],
      ['no such page', randomUUID()],
    ] as const) {
      const r = await http({ key: keyOf.user! }, 'PATCH', `/api/v1/pages/${id}`, doc);
      note(`api-v1 user PATCH /api/v1/pages/:id doc, ${cell}`, r);
      if (r.status !== 404) failures.push(`PATCH doc, ${cell}: ${r.status} ${r.text}`);
    }

    // The owner's key: unchanged, every item read.
    const own = await makeItem('note', ws.admin);
    const ownRead = await http({ key: keyOf.owner! }, 'GET', `/api/v1/notes/${own}`);
    note('api-v1 owner GET /api/v1/notes/:id', ownRead);
    if (!ownRead.ok) failures.push(`owner key read: ${ownRead.status}`);
    expect(failures).toEqual([]);
  }, 600_000);

  // ── F2: a workspace assistant's turn writes with its user's rights ─────

  type Surface = 'web-turn' | 'team-turn' | 'telegram' | 'run' | 'recipe';
  const SURFACES: Surface[] = ['web-turn', 'team-turn', 'telegram', 'run', 'recipe'];
  /** The surfaces an owner-side tool (tree_item_move) runs on: a chat on
   *  the web or Telegram (and a recipe in one); never the team chat or a
   *  run item, which names no surface. */
  const OWNER_SIDE = new Set<Surface>(['web-turn', 'telegram', 'recipe']);

  const tools = new Map<string, import('@mantle/db').Tool>();
  const toolRow = async (slug: string) => {
    if (!tools.has(slug)) {
      const row = await m.asSystem(() => t.resolveTool(L.owner, slug), 'test');
      if (!row) throw new Error(`no tool ${slug}`);
      tools.set(slug, row);
    }
    return tools.get(slug)!;
  };

  /** The surface a turn of `login` names, as its chat does. */
  const surfaceOf = (surface: Surface, login: string) =>
    surface === 'team-turn'
      ? { kind: 'team', loginId: login }
      : surface === 'telegram'
        ? { kind: 'telegram', telegramChatId: '1', loginId: login }
        : { kind: 'web', loginId: login };

  /** One tool call in `who`'s turn with the assistant of W, on `surface`.
   *  A turn enters its scope as the tool loop does (runToolLoop): the
   *  login the surface names (a team or Telegram chat's), or a web chat's
   *  signed-in login as an owner surface (fix round 1, finding 8: never a
   *  login the test hands it). `before` runs in the turn, first. */
  const inTurn = async (
    surface: Surface,
    who: Who | 'owner',
    slug: string,
    input: Record<string, unknown>,
    before?: () => Promise<void>,
  ): Promise<Outcome> => {
    const login = L[who];
    const actor = m.loginActor(login, who === 'owner' ? 'owner' : 'rw');
    try {
      if (surface === 'run') {
        const res = await m.runAsActor(actor, () =>
          rt.withRunScope({ workspaceId: ws.W, loginId: login, ownerId: L.owner }, async () => {
            await before?.();
            return t.dispatchTool(await toolRow(slug), input, {
              ownerId: L.owner,
              caller: t.runCaller(),
            });
          }),
        );
        return { ok: res.ok, text: res.ok ? JSON.stringify(res.output ?? '') : String(res.error) };
      }
      const tool =
        surface === 'recipe'
          ? ({
              slug: `${tag}_recipe`,
              handler: { kind: 'recipe', steps: [{ tool: slug, input }] },
              inputSchema: { type: 'object', properties: {} },
            } as never)
          : await toolRow(slug);
      const surf = surfaceOf(surface, login);
      const res = await m.runAsActor(actor, () =>
        rt.withAgentScope(
          { id: agentW, ownerId: L.owner, workspaceId: ws.W, role: 'responder' },
          async () => {
            await before?.();
            return t.dispatchTool(tool, surface === 'recipe' ? {} : input, {
              ownerId: L.owner,
              surface: surf as never,
              caller: t.turnCaller(),
            });
          },
          { loginId: rt.surfaceLoginId(surf), ownerLoginId: rt.ownerSurfaceLogin(surf) },
        ),
      );
      return { ok: res.ok, text: res.ok ? JSON.stringify(res.output ?? '') : String(res.error) };
    } catch (err) {
      return { ok: false, text: `THROWN ${(err as Error).message}` };
    }
  };

  it('F2: a workspace assistant writes for its user, in its workspace, on every surface', async () => {
    const failures: string[] = [];
    const check = async (
      cell: string,
      want: boolean,
      run: () => Promise<Outcome>,
      ids: string[],
      changed?: (before: string[], after: string[]) => boolean,
    ) => {
      const before = await Promise.all(ids.map(probe));
      const out = await run();
      const after = await Promise.all(ids.map(probe));
      note(cell, out);
      const moved = changed ? changed(before, after) : after.some((a, i) => a !== before[i]);
      if (RAW.test(out.text) || out.text.startsWith('THROWN')) {
        failures.push(`${cell}: raw text: ${out.text.slice(0, 160)}`);
      }
      if (want && !(out.ok && moved))
        failures.push(`${cell}: refused, want allowed: ${out.text.slice(0, 160)}`);
      if (!want && (out.ok || moved)) failures.push(`${cell}: allowed, want refused`);
    };
    for (const surface of SURFACES) {
      for (const who of ['mod', 'user'] as const) {
        const isMod = who === 'mod';
        const c = (what: string) => `${surface} ${who} ${what}`;
        // Homed in W: its Moderator edits, deletes and files it; a plain
        // user of W does not.
        const inW = await makeItem('task', ws.W);
        await check(
          c('edit task homed in W'),
          isMod,
          () => inTurn(surface, who, 'task_update', { id: inW, title: `${tag} e1` }),
          [inW],
        );
        const delW = await makeItem('task', ws.W);
        await check(
          c('delete task homed in W'),
          isMod,
          () => inTurn(surface, who, 'task_delete', { id: delW }),
          [delW],
        );
        // Homed in H with W's grant, Write on: both edit it; neither
        // deletes it (the Moderator's seat in H is outside W).
        const hw = await makeItem('task', ws.H, [{ ws: ws.W, write: true }]);
        await check(
          c('edit task granted to W with Write on'),
          true,
          () => inTurn(surface, who, 'task_update', { id: hw, title: `${tag} e2` }),
          [hw],
        );
        const hwDel = await makeItem('task', ws.H, [{ ws: ws.W, write: true }]);
        await check(
          c('delete task homed in H (a seat outside W)'),
          false,
          () => inTurn(surface, who, 'task_delete', { id: hwDel }),
          [hwDel],
        );
        // Write off: read only.
        const hr = await makeItem('task', ws.H, [{ ws: ws.W, write: false }]);
        await check(
          c('edit task granted to W with Write off'),
          false,
          () => inTurn(surface, who, 'task_update', { id: hr, title: `${tag} e3` }),
          [hr],
        );
        // Not granted to W: not even read.
        const hOnly = await makeItem('task', ws.H);
        await check(
          c('edit task not granted to W'),
          false,
          () => inTurn(surface, who, 'task_update', { id: hOnly, title: `${tag} e4` }),
          [hOnly],
        );
        // Move into folder F (homed in W): manage the item, edit F, on an
        // owner-side surface (OWNER_SIDE).
        const mv = await makeItem('task', ws.W);
        await check(
          c('move task homed in W into F'),
          isMod && OWNER_SIDE.has(surface),
          () =>
            inTurn(surface, who, 'tree_item_move', {
              kind: 'tasks',
              item_ids: [mv],
              folder_id: folderF,
              confirm: true,
            }),
          [mv],
        );
        const mvH = await makeItem('task', ws.H, [{ ws: ws.W, write: true }]);
        await check(
          c('move task homed in H into F'),
          false,
          () =>
            inTurn(surface, who, 'tree_item_move', {
              kind: 'tasks',
              item_ids: [mvH],
              folder_id: folderF,
              confirm: true,
            }),
          [mvH],
        );
        // A create: in W for its Moderator, else the user's private
        // workspace (the home rule).
        const title = `${tag} created ${surface} ${who} ${randomUUID().slice(0, 6)}`;
        const made = await inTurn(surface, who, 'task_create', { title });
        note(c('create task'), made);
        const [row] = await raw<{ home: string | null }[]>`
          select home_ws::text as home from nodes where title = ${title}`;
        if (RAW.test(made.text)) failures.push(`${c('create task')}: raw text`);
        if (!made.ok || !row)
          failures.push(`${c('create task')}: refused: ${made.text.slice(0, 160)}`);
        else if (isMod ? row.home !== ws.W : row.home === ws.W) {
          failures.push(`${c('create task')}: landed in ${row.home}`);
        }
      }
      // L5: the Moderator's seat in W taken away during the turn, before
      // its write: refused in the seat's words, nothing written.
      if (surface !== 'recipe') {
        const seat = await makeItem('task', ws.W);
        await check(
          `${surface} mod edit task homed in W, seat taken away during the turn`,
          false,
          () =>
            inTurn(surface, 'mod', 'task_update', { id: seat, title: `${tag} e5` }, async () => {
              await raw`update workspace_users set moderator = false
                         where workspace_id = ${ws.W} and login_id = ${L.mod}`;
            }),
          [seat],
        );
        await raw`update workspace_users set moderator = true
                   where workspace_id = ${ws.W} and login_id = ${L.mod}`;
        const said = recorded[recorded.length - 1] ?? '';
        if (!said.includes(t.MODERATOR_SEAT_CHANGED.slice(0, 40))) {
          failures.push(`${surface} seat taken away: ${said}`);
        }
      }
    }
    // A web chat whose login is no user of W (the owner here): its turn
    // answers no login and only reads, as before.
    const ownerWeb = await makeItem('task', ws.W);
    await check(
      'web-turn owner (no user of W) edit task homed in W',
      false,
      () => inTurn('web-turn', 'owner', 'task_update', { id: ownerWeb, title: `${tag} e6` }),
      [ownerWeb],
    );
    expect(failures).toEqual([]);
  }, 900_000);

  it('a turn with no user only reads, and its refused writes carry no raw text', async () => {
    const failures: string[] = [];
    const heartbeat = async (slug: string, input: Record<string, unknown>) => {
      try {
        const res = await m.runAsActor({ kind: 'assistant', agentId: agentW }, () =>
          rt.withAgentScope({ id: agentW, ownerId: L.owner, workspaceId: ws.W }, async () =>
            t.dispatchTool(await toolRow(slug), input, {
              ownerId: L.owner,
              surface: { kind: 'web', loginId: null } as never,
              caller: t.turnCaller(),
            }),
          ),
        );
        return { ok: res.ok, text: res.ok ? JSON.stringify(res.output ?? '') : String(res.error) };
      } catch (err) {
        return { ok: false, text: `THROWN ${(err as Error).message}` };
      }
    };
    for (const [slug, kind] of [
      ['note_update', 'note'],
      ['task_update', 'task'],
      ['task_delete', 'task'],
    ] as const) {
      const id = await makeItem(kind, ws.W);
      const before = await probe(id);
      const out = await heartbeat(slug, { id, title: `${tag} hb` });
      note(`heartbeat ${slug}`, out);
      if (out.ok || (await probe(id)) !== before) failures.push(`heartbeat ${slug}: wrote`);
      if (RAW.test(out.text) || out.text.startsWith('THROWN')) {
        failures.push(`heartbeat ${slug}: raw text: ${out.text.slice(0, 160)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);
  // ── Fix round 1: F1's ?ws=, HEAD, a read-only key; L4 ───────────────────

  it('F1 fix round 1: a v1 create reads ?ws= as its base; HEAD; a read-only key; L4', async () => {
    const failures: string[] = [];
    const homeOf = async (title: string) =>
      (
        await raw<{ home: string | null }[]>`
          select home_ws::text as home from nodes where title = ${title}`
      )[0]?.home ?? null;
    // ?ws= (L3): each key, the v1 create and its base, with and without it.
    const sides: Array<[string, string | { key: string }, string | { key: string }, string]> = [
      ['mod', { key: keyOf.mod! }, L.mod, ws.W],
      ['user', { key: keyOf.user! }, L.user, ws.W],
      ['owner', { key: keyOf.owner! }, L.owner, ws.admin],
    ];
    for (const [who, key, session, target] of sides) {
      for (const [v1, base] of [
        ['/api/v1/tasks', '/api/tasks'],
        ['/api/v1/notes', '/api/notes'],
      ] as const) {
        for (const q of [`?ws=${target}`, '']) {
          const t1 = `${tag} ws ${who} v1 ${randomUUID().slice(0, 6)}`;
          const t2 = `${tag} ws ${who} base ${randomUUID().slice(0, 6)}`;
          const a = await http(key, 'POST', `${v1}${q}`, { title: t1 });
          const b = await http(session, 'POST', `${base}${q}`, { title: t2 });
          const [ha, hb] = [await homeOf(t1), await homeOf(t2)];
          const cell = `api-v1 ${who} POST ${v1}${q ? '?ws=' : ''}`;
          note(
            `${cell} -> ${ha === ws.W ? 'W' : ha === ws.admin ? 'admin' : ha ? 'private' : '-'}`,
            a,
          );
          if (a.status !== b.status || ha !== hb) {
            failures.push(`${cell}: v1 ${a.status} ${ha}, base ${b.status} ${hb}`);
          }
          if (who === 'mod' && q && ha !== ws.W) failures.push(`${cell}: landed in ${ha}`);
          if (RAW.test(a.text)) failures.push(`${cell}: raw text`);
        }
      }
    }
    // HEAD: a member key on a v1 row answers as the base row's HEAD.
    for (const who of ['mod', 'user'] as const) {
      const viaKey = await makeItem('note', ws.W);
      const viaBase = await makeItem('note', ws.W);
      for (const [v1, base] of [
        [`/api/v1/notes/${viaKey}`, `/api/notes/${viaBase}`],
        ['/api/v1/tasks', '/api/tasks'],
        ['/api/v1/contacts', '/api/contacts'],
      ] as const) {
        const a = await http({ key: keyOf[who]! }, 'HEAD', v1);
        const b = await http(L[who], 'HEAD', base);
        note(`api-v1 ${who} HEAD ${v1.replace(viaKey, ':id')}`, a);
        if (a.status !== b.status)
          failures.push(`${who} HEAD ${v1}: v1 ${a.status}, base ${b.status}`);
      }
    }
    // A read-only key of a member: reads, never writes.
    const read = await http({ key: keyOf.modRead! }, 'GET', '/api/v1/notes');
    note('api-v1 mod read-only key GET /api/v1/notes', read);
    if (read.status !== 200) failures.push(`read-only key read: ${read.status}`);
    const write = await http({ key: keyOf.modRead! }, 'POST', '/api/v1/notes', {
      title: `${tag} read only`,
    });
    note('api-v1 mod read-only key POST /api/v1/notes', write);
    if (write.status !== 403 || !write.text.includes('key-read-only')) {
      failures.push(`read-only key write: ${write.status} ${write.text}`);
    }
    // L4: an Admin user's key meets the page route's item gate before the
    // key's shared-content rule reads the page: a shared page outside its
    // scope gets the base route's answer to that login (an Admin user may
    // add itself to any workspace: 403 item-workspace, "Add yourself to it
    // first"), never key-shared-item; a shared page it may change still
    // meets the rule.
    const doc = { doc: { type: 'doc', content: [] } };
    const outside = await makeItem('page', ws.H, [{ ws: ws.W, write: false }]);
    const viaKey = await http({ key: keyOf.admin! }, 'PATCH', `/api/v1/pages/${outside}`, doc);
    const viaBase = await http(L.admin, 'PATCH', `/api/pages/${outside}`, doc);
    note('api-v1 admin PATCH /api/v1/pages/:id doc, a shared page outside its scope', viaKey);
    note('base   admin PATCH /api/pages/:id doc, a shared page outside its scope', viaBase);
    if (viaKey.status !== viaBase.status || viaKey.text.includes('key-shared-item')) {
      failures.push(
        `admin key, outside: v1 ${viaKey.status} ${viaKey.text}, base ${viaBase.status}`,
      );
    }
    await raw`update workspace_users set moderator = true
               where workspace_id = ${ws.admin} and login_id = ${L.admin}`;
    try {
      const inside = await makeItem('page', ws.admin, [{ ws: ws.W, write: false }]);
      const r = await http({ key: keyOf.admin! }, 'PATCH', `/api/v1/pages/${inside}`, doc);
      note('api-v1 admin PATCH /api/v1/pages/:id doc, a shared page it may change', r);
      if (r.status !== 403 || !r.text.includes('key-shared-item')) {
        failures.push(`admin key, inside: ${r.status} ${r.text}`);
      }
    } finally {
      await raw`update workspace_users set moderator = false
                 where workspace_id = ${ws.admin} and login_id = ${L.admin}`;
    }
    expect(failures).toEqual([]);
  }, 600_000);

  // ── Approval: a workspace turn's queued call (plan section 31) ─────────

  it('approval: another approver runs a workspace turn’s queued call; an asker never approves an elevated one', async () => {
    const failures: string[] = [];
    await raw`update tools set requires_confirm = true
               where owner_id = ${L.owner} and slug = 'task_update'`;
    try {
      /** Queue `slug` for `who` in a team turn with W's assistant, through
       *  the tool loop's own queue path. The pending row's id, or null. */
      const queue = async (who: Who, slug: string, input: Record<string, unknown>) => {
        const login = L[who];
        const row = await m.asSystem(() => t.resolveTool(L.owner, slug), 'test');
        const surface = { kind: 'team', loginId: login };
        const pendingIds: string[] = [];
        const res = await m.runAsActor(m.loginActor(login, 'rw'), () =>
          rt.withAgentScope(
            { id: agentW, ownerId: L.owner, workspaceId: ws.W, role: 'responder' },
            () =>
              tracing.startTrace(
                { kind: 'responder_turn', ownerId: L.owner, agentId: agentW, loginId: login },
                () =>
                  ex.executeToolCall({
                    args: {
                      ownerId: L.owner,
                      agentId: agentW,
                      agentSlug: `${tag}-w`,
                      surface,
                    } as never,
                    slug,
                    call: { id: `call-${randomUUID()}`, function: { name: slug, arguments: '{}' } },
                    tool: row!,
                    input,
                    argParseError: null,
                    argValidation: null,
                    argValidationMode: 'off',
                    lastUserMessage: undefined,
                    pendingIds,
                  }),
              ),
            { loginId: rt.surfaceLoginId(surface), ownerLoginId: rt.ownerSurfaceLogin(surface) },
          ),
        );
        if (pendingIds.length !== 1) {
          failures.push(`queue ${who} ${slug}: not queued: ${JSON.stringify(res).slice(0, 160)}`);
          return null;
        }
        return pendingIds[0]!;
      };
      const statusOf = async (id: string) =>
        (
          await raw<{ s: string }[]>`select status::text as s from pending_tool_calls
                                     where id = ${id}`
        )[0]?.s ?? 'gone';
      /** `approver` approves `id` (the batch path: approvePendingCall). */
      const approve = async (approver: 'owner' | 'mod' | 'user' | 'user2', id: string) => {
        const login = L[approver];
        try {
          const row = await m.runAsActor(
            m.loginActor(login, approver === 'owner' ? 'owner' : 'rw'),
            () => t.approvePendingCall(L.owner, id, { approverLoginId: login }),
          );
          return { ok: !!row, text: row ? 'approved' : 'not found' };
        } catch (err) {
          return { ok: false, text: err instanceof Error ? err.message : String(err) };
        }
      };

      // A call that is not elevated: its asker's write in W, approved by
      // the owner (not its asker), runs in the scope it was asked in.
      for (const [who, id] of [
        ['mod', await makeItem('task', ws.W)],
        ['user', await makeItem('task', ws.H, [{ ws: ws.W, write: true }])],
      ] as const) {
        const before = await probe(id);
        const pending = await queue(who, 'task_update', { id, title: `${tag} approved ${who}` });
        if (!pending) continue;
        const out = await approve('owner', pending);
        note(`approval ${who} task_update, the owner approves`, out);
        if (!out.ok || (await probe(id)) === before) {
          failures.push(`${who} task_update approved by the owner: did not write: ${out.text}`);
        }
        if (RAW.test(out.text)) failures.push(`${who} task_update approval: raw text`);
      }

      // An elevated call (a plain user's connector write): its asker never
      // approves it; another user approves it only with its own connector
      // write rights in W (the Moderator, the connector's Write on); the
      // owner always.
      const cells: Array<['user' | 'user2' | 'mod' | 'owner', boolean]> = [
        ['user', false],
        ['user2', false],
        ['mod', true],
      ];
      const elevated = await queue('user', CONNECTOR, { id: 'c-1' });
      if (elevated) {
        for (const [approver, runs] of cells) {
          const calls = remote.calls.length;
          const out = await approve(approver, elevated);
          note(`approval user ${CONNECTOR} (elevated), ${approver} approves`, out);
          const ran = remote.calls.length > calls;
          const status = await statusOf(elevated);
          if (ran !== runs) failures.push(`elevated, ${approver}: ran ${ran}, want ${runs}`);
          if (!runs && status !== 'pending') {
            failures.push(`elevated, ${approver}: left ${status}, want pending`);
          }
          if (RAW.test(out.text)) failures.push(`elevated, ${approver}: raw text`);
        }
      }
      const byOwner = await queue('user', CONNECTOR, { id: 'c-2' });
      if (byOwner) {
        const calls = remote.calls.length;
        const out = await approve('owner', byOwner);
        note(`approval user ${CONNECTOR} (elevated), owner approves`, out);
        if (remote.calls.length === calls)
          failures.push(`elevated, owner: did not run: ${out.text}`);
      }
    } finally {
      await raw`update tools set requires_confirm = false
                 where owner_id = ${L.owner} and slug = 'task_update'`;
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
