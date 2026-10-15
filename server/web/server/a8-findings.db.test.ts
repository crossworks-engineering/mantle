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
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `a8f${randomUUID().slice(0, 6)}`;
  const L = { owner: randomUUID(), mod: randomUUID(), user: randomUUID() };
  type Who = 'mod' | 'user';
  const ws = { admin: '', W: '', H: '' };
  const agentW = randomUUID();
  const rootOf: Record<string, { id: string; path: string }> = {};
  let folderF = '';
  const keyOf: Partial<Record<'owner' | Who, string>> = {};
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

  /** What a probe reads of an item: its title and home, or gone. */
  const probe = async (id: string) => {
    const [row] = await raw<{ title: string; home: string | null; parent: string | null }[]>`
      select title, home_ws::text as home, parent_id::text as parent from nodes where id = ${id}`;
    return row ? `${row.title}|${row.home}|${row.parent}` : 'gone';
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
    delete process.env.MANTLE_ADMIN_READS;
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the A8 findings test', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    rt = await import('@mantle/runtime/agent');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    // The anchor, a Moderator of W and of H (its H seat is outside the
    // assistant's workspace), and a plain user of W.
    for (const [who, id] of Object.entries(L)) {
      await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${id}, ${`${tag}-${who}@example.invalid`}, 'x', ${who === 'owner'},
                ${who === 'owner' ? 'admin' : 'member'}, ${who})`;
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
                 and u.login_id in (${L.mod}, ${L.user})`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.W}, ${L.mod}, true), (${ws.H}, ${L.mod}, true), (${ws.W}, ${L.user}, false)`;
    for (const who of ['mod', 'user'] as const) {
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
    await raw`select mantle_set_actor_check('warn')`;
    await m.asSystem(() => t.seedBuiltinTools(L.owner), 'test');
    const keys = await import('../lib/access-keys');
    for (const who of ['owner', 'mod', 'user'] as const) {
      const minted = await m.asSystem(
        () =>
          keys.mintAccessKey({
            name: `${tag} ${who}`,
            loginId: L[who],
            access: 'read_write',
            areas: null,
            riskyTools: [],
            expiresAt: new Date(Date.now() + 30 * 86_400_000),
            createdBy: L[who],
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
  }, 300_000);

  afterAll(async () => {
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

  /** One tool call in `who`'s turn with the assistant of W, on `surface`. */
  const inTurn = async (
    surface: Surface,
    who: Who,
    slug: string,
    input: Record<string, unknown>,
  ): Promise<Outcome> => {
    const login = L[who];
    const actor = m.loginActor(login, 'rw');
    try {
      if (surface === 'run') {
        const res = await m.runAsActor(actor, () =>
          rt.withRunScope({ workspaceId: ws.W, loginId: login, ownerId: L.owner }, async () =>
            t.dispatchTool(await toolRow(slug), input, {
              ownerId: L.owner,
              caller: t.runCaller(),
            }),
          ),
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
      const kind = surface === 'team-turn' ? 'team' : surface === 'telegram' ? 'telegram' : 'web';
      const res = await m.runAsActor(actor, () =>
        rt.withAgentScope(
          { id: agentW, ownerId: L.owner, workspaceId: ws.W },
          () =>
            t.dispatchTool(tool, surface === 'recipe' ? {} : input, {
              ownerId: L.owner,
              surface: { kind, loginId: login } as never,
              caller: t.turnCaller(),
            }),
          { loginId: login },
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
    }
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
});
