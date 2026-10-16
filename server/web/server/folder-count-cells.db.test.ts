/**
 * Folder counts as each caller sees them (task b6e4a8aa; workspaces arch
 * plan v2, A8 surface cells against the oracle's `expectedFolderCount`,
 * packages/db/src/matrix/oracle.ts). Through the real app (a session cookie
 * per login, GET /api/tree/notes with and without `?ws=`) and the real MCP
 * surface (the Admin-only `tree_folders` and `tree_folder_update` tools).
 *
 * The fixture: folders F and G, homed in H and granted to S (Write on). F
 * holds three notes, two of them "Removed here" for S: S reads one of
 * three. G holds three notes and a subfolder, all "Removed here" for S: S
 * reads nothing in G, which still shows (an Admin user shares empty folders
 * to give a workspace its structure). The callers: a member (a user of S),
 * an Admin user who is a user (and Moderator) of S, and an Admin user who
 * is a user of H and S.
 *
 * Each count must also be what the folder shows when opened in the same
 * scope (the one count path), and the reply of a folder write must carry
 * the same counts (it is read on the system pool, in the caller's scope).
 * A move's confirm list names and counts only the items the caller reads.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/folder-count-cells.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expectedFolderCount,
  type FolderCountCaller,
  type FolderCountCase,
  type FolderCountScope,
} from '@mantle/db/matrix/oracle';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, any>;
type Counts = { itemCount: number; folderCount: number };

const CASES: readonly FolderCountCase[] = ['oneOfThree', 'noneShared'];
const CALLERS: readonly FolderCountCaller[] = ['member', 'adminUser', 'adminUserInHome'];
const SCOPES: readonly FolderCountScope[] = ['all', 'S', 'H'];

describe.skipIf(!DB_URL)('A8 cells: folder counts are the caller’s', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let dir = '';
  const tag = `fc${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const login: Record<FolderCountCaller, string> = {
    member: randomUUID(),
    adminUser: randomUUID(),
    adminUserInHome: randomUUID(),
  };
  const cookie: Partial<Record<FolderCountCaller, string>> = {};
  /** H and S of the oracle; T only reads the move's destination. */
  const ws = { H: randomUUID(), S: randomUUID(), T: randomUUID() };
  /** Each case's folder and its path. */
  const folder: Record<FolderCountCase, string> = { oneOfThree: '', noneShared: '' };
  const pathOf: Record<FolderCountCase, string> = {
    oneOfThree: `notes.${tag}_one`,
    noneShared: `notes.${tag}_none`,
  };
  /** The subfolder of G, not read by S. */
  let sub = '';
  /** The move fixture: folder `moved` (home S) holds `seen` (read by S)
   *  and `hidden` (home H, "Removed here" for S); `dest` (home S) is also
   *  granted to T. */
  const mv = { moved: randomUUID(), seen: randomUUID(), hidden: randomUUID(), dest: randomUUID() };
  /** A folder only H reads, holding a subfolder granted to S by hand. */
  const hOnly = { parent: randomUUID(), child: randomUUID() };

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** A new row under `parent` (heads first, `share` on the folder). */
  const insert = (parent: string, id: string, type: string, title: string, at: string) =>
    m.withHeads([parent], 'share', (tx) =>
      tx.execute(sql`insert into nodes (id, owner_id, type, title, path, data)
        values (${id}, ${owner}, ${type}::node_type, ${title}, ${at}::ltree,
                ${type === 'note' ? '{"content":"x"}' : '{}'}::jsonb)`),
    );
  /** A grant the row already takes from its folder becomes a hand grant. */
  const asHandGrant = sql`on conflict (node_id, workspace_id) do update
    set is_home = excluded.is_home, write = excluded.write, via_folder_id = null`;
  /** Its hand grants replaced: `home` is the home, then each of `also`
   *  (Write on). A folder passes its grants on to what it holds. */
  const grants = (id: string, home: string, ...also: string[]) =>
    m.withSubtreeHeads(id, [], async (tx) => {
      await tx.execute(
        sql`delete from item_grants where node_id = ${id} and via_folder_id is null`,
      );
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home, write)
        values (${id}, ${home}, true, false) ${asHandGrant}`);
      for (const w of also) {
        await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home, write)
          values (${id}, ${w}, false, true) ${asHandGrant}`);
      }
    });
  /** "Remove from this workspace": S marked "Removed here" on `id`. */
  const removeFromS = (id: string) =>
    m.withSubtreeHeads(id, [], (tx) =>
      tx.execute(sql`insert into item_grants (node_id, workspace_id, excluded)
        values (${id}, ${ws.S}, true)
        on conflict (node_id, workspace_id) do update set excluded = true, via_folder_id = null`),
    );

  const send = async (who: FolderCountCaller, url: string, method = 'GET', body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: { cookie: cookie[who]!, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const get = async (who: FolderCountCaller, url: string): Promise<Json> => {
    const res = await send(who, url);
    expect(res.status, `${who} GET ${url}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
    return res.body;
  };
  const wsQuery = (scope: FolderCountScope) =>
    scope === 'all' ? '' : `&ws=${scope === 'S' ? ws.S : ws.H}`;

  /** The counts the root lists for each case's folder, as `who` in `scope`;
   *  null for a folder the root does not list. */
  const listed = async (who: FolderCountCaller, scope: FolderCountScope) => {
    const root = await get(who, `/api/tree/notes?sort=name${wsQuery(scope)}`);
    const by = new Map((root.folders as Json[]).map((f) => [f.id as string, f]));
    const out = {} as Record<FolderCountCase, Counts | null>;
    for (const c of CASES) {
      const f = by.get(folder[c]);
      out[c] = f ? { itemCount: f.itemCount, folderCount: f.folderCount } : null;
    }
    return out;
  };
  /** What the folder shows when `who` opens it in `scope`. */
  const opened = async (who: FolderCountCaller, scope: FolderCountScope, id: string) => {
    const page = await get(who, `/api/tree/notes?folder=${id}&sort=name${wsQuery(scope)}`);
    expect(page.folder?.id).toBe(id);
    return {
      shown: {
        itemCount: (page.items as Json[]).length,
        folderCount: (page.folders as Json[]).length,
      },
      self: { itemCount: page.folder.itemCount, folderCount: page.folder.folderCount },
    };
  };

  /** One MCP tool call as `who` (an Admin user), its JSON output. */
  const mcpCall = async (who: FolderCountCaller, name: string, args: Json): Promise<unknown> => {
    const ls = await import('@mantle/mcp-core');
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(
      server,
      await ls.prepareCallerTools({
        role: 'admin',
        anchorId: owner,
        loginId: login[who],
        via: 'oauth',
        write: true,
      }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'test-client', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    try {
      const res = (await m.runAsActor(m.loginActor(login[who], 'rw'), () =>
        c.callTool({ name, arguments: args }),
      )) as { isError?: boolean; content?: { text?: string }[] };
      expect(res.isError, JSON.stringify(res.content)).not.toBe(true);
      return JSON.parse(res.content![0]!.text!);
    } finally {
      await c.close();
    }
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'folder-counts-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'folder-count-cells-secret-at-least-32-characters';
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    m = await import('@mantle/db');
    const email = (who: string) => `${tag}-${who}@example.invalid`;
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${email('o')}, 'x', true, 'admin'),
      (${login.member}, ${email('m')}, 'x', false, 'member'),
      (${login.adminUser}, ${email('a')}, 'x', false, 'admin'),
      (${login.adminUserInHome}, ${email('h')}, 'x', false, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    await x(sql`insert into workspaces (id, owner_id, name) values
      (${ws.H}, ${owner}, ${`${tag} H`}), (${ws.S}, ${owner}, ${`${tag} S`}),
      (${ws.T}, ${owner}, ${`${tag} T`})`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.S}, ${login.member}, false), (${ws.S}, ${login.adminUser}, true),
      (${ws.S}, ${login.adminUserInHome}, false), (${ws.H}, ${login.adminUserInHome}, false)`);
    // The member's Team seat would not change a cell (nothing is granted to
    // Team); taken out so its scope is exactly S.
    await x(sql`delete from workspace_users u using workspaces w
      where w.id = u.workspace_id and w.name = 'Team' and not w.is_admin and u.login_id = ${login.member}`);
    // Both Admin users sit in Admin (the switch seats admin rows).
    const seated = await x<{ n: number }>(sql`select count(*)::int as n
      from workspace_users u join workspaces w on w.id = u.workspace_id and w.is_admin
      where u.login_id in (${login.adminUser}, ${login.adminUserInHome})`);
    expect(seated[0]!.n).toBe(2);

    const tree = await import('@mantle/content/tree');
    await tree.ensureKindRoot(owner, 'notes');
    const [root] = await x<{ id: string }>(sql`select id::text as id from nodes
      where owner_id = ${owner} and type = 'branch' and path = 'notes'::ltree`);
    for (const c of CASES) {
      const id = randomUUID();
      folder[c] = id;
      await insert(root!.id, id, 'branch', `${tag} ${c}`, pathOf[c]);
      await grants(id, ws.H, ws.S);
      for (let i = 0; i < 3; i += 1) {
        const note = randomUUID();
        await insert(id, note, 'note', `${tag} ${c} ${i}`, pathOf[c]);
        // S keeps the first note of "one of three", none of "none shared".
        if (c === 'noneShared' || i > 0) await removeFromS(note);
      }
      if (c === 'noneShared') {
        sub = randomUUID();
        await insert(id, sub, 'branch', `${tag} sub`, `${pathOf[c]}.sub`);
        await removeFromS(sub);
      }
    }
    // The move: `moved` and `dest` homed in S; `hidden` re-homed in H and
    // "Removed here" for S, so no user of S reads it.
    await insert(root!.id, mv.moved, 'branch', `${tag} moved`, `notes.${tag}_moved`);
    await grants(mv.moved, ws.S);
    await insert(mv.moved, mv.seen, 'note', `${tag} seen note`, `notes.${tag}_moved`);
    await insert(mv.moved, mv.hidden, 'note', `${tag} hidden note`, `notes.${tag}_moved`);
    await grants(mv.hidden, ws.H);
    await removeFromS(mv.hidden);
    await insert(root!.id, mv.dest, 'branch', `${tag} dest`, `notes.${tag}_dest`);
    await grants(mv.dest, ws.S, ws.T);
    await insert(root!.id, hOnly.parent, 'branch', `${tag} h only`, `notes.${tag}_honly`);
    await grants(hOnly.parent, ws.H);
    await insert(hOnly.parent, hOnly.child, 'branch', `${tag} s child`, `notes.${tag}_honly.s`);
    await grants(hOnly.child, ws.H, ws.S);

    const tokens = await import('../lib/auth/tokens');
    for (const who of CALLERS) {
      cookie[who] = `mantle_session=${tokens.buildSessionCookie(login[who]).value}`;
    }
    const { createApp } = await import('./app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
    // The scratch drop waits for the app's pools: slow under a full suite.
  }, 60_000);

  it('the fixture: H is the home, S reads one note of F, nothing in G, not the hidden note', async () => {
    const rows = await x<{ path: string; s: boolean; home: string }>(sql`
      select path::text as path, ${ws.S}::uuid = any(read_ws) as s, home_ws::text as home
        from nodes
       where owner_id = ${owner}
         and (path <@ ${pathOf.oneOfThree}::ltree or path <@ ${pathOf.noneShared}::ltree)`);
    // Two folders, six notes, one subfolder.
    expect(rows.length).toBe(9);
    for (const r of rows) expect(r.home).toBe(ws.H);
    const sReads = (c: FolderCountCase) =>
      rows.filter((r) => (r.path === pathOf[c] || r.path.startsWith(`${pathOf[c]}.`)) && r.s)
        .length;
    // F's own row and one note; G's own row only.
    expect(sReads('oneOfThree')).toBe(2);
    expect(sReads('noneShared')).toBe(1);
    const moved = await x<{ id: string; s: boolean; home: string }>(sql`
      select id::text as id, ${ws.S}::uuid = any(read_ws) as s, home_ws::text as home
        from nodes where id in (${mv.seen}, ${mv.hidden})`);
    const by = new Map(moved.map((r) => [r.id, r]));
    expect(by.get(mv.seen)).toMatchObject({ s: true, home: ws.S });
    expect(by.get(mv.hidden)).toMatchObject({ s: false, home: ws.H });
  });

  it('the tree (http): each caller and scope gets the oracle’s counts, and opening shows them', async () => {
    const failures: string[] = [];
    for (const who of CALLERS) {
      for (const scope of SCOPES) {
        const cell = `${who} ${scope}`;
        const probe = expectedFolderCount('oneOfThree', who, scope);
        // The landing page takes the same pick (one helper, parseWsFilter).
        if (scope !== 'all') {
          const home = await send(who, `/api/home?x=1${wsQuery(scope)}`);
          const wantHome = 'refused' in probe ? 404 : 200;
          if (home.status !== wantHome) {
            failures.push(`${cell}: /api/home ${home.status}, the tree pick wants ${wantHome}`);
          }
        }
        if ('refused' in probe) {
          const res = await send(who, `/api/tree/notes?sort=name${wsQuery(scope)}`);
          if (res.status !== 404) failures.push(`${cell}: ${res.status}, the oracle refuses`);
          continue;
        }
        const got = await listed(who, scope);
        for (const c of CASES) {
          const want = expectedFolderCount(c, who, scope);
          if ('refused' in want) continue;
          const row = got[c];
          if (!row) {
            failures.push(`${cell} ${c}: not listed, the oracle shows it`);
            continue;
          }
          const expected = { itemCount: want.items, folderCount: want.folders };
          if (JSON.stringify(row) !== JSON.stringify(expected)) {
            failures.push(
              `${cell} ${c}: ${JSON.stringify(row)}, the oracle says ${JSON.stringify(expected)}`,
            );
          }
          const open = await opened(who, scope, folder[c]);
          if (JSON.stringify(open.shown) !== JSON.stringify(row)) {
            failures.push(
              `${cell} ${c}: lists ${JSON.stringify(row)}, opens to ${JSON.stringify(open.shown)}`,
            );
          }
          if (JSON.stringify(open.self) !== JSON.stringify(row)) {
            failures.push(`${cell} ${c}: the open folder says ${JSON.stringify(open.self)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('the MCP tree_folders tool (Admin only, all the login’s workspaces) gives the same counts', async () => {
    for (const who of ['adminUser', 'adminUserInHome'] as const) {
      const rows = new Map(
        ((await mcpCall(who, 'tree_folders', { kind: 'notes' })) as Json[]).map((r) => [r.id, r]),
      );
      for (const c of CASES) {
        const want = expectedFolderCount(c, who, 'all');
        if ('refused' in want) throw new Error('the oracle refuses no scope of all');
        expect(rows.get(folder[c]), `${who} ${c}`).toMatchObject({
          items: want.items,
          subfolders: want.folders,
        });
      }
      expect(rows.has(sub), who).toBe(who === 'adminUserInHome');
    }
  }, 60_000);

  it('the reply of a folder write carries the caller’s counts (http and MCP)', async () => {
    // Write on through S: the member and the Admin user of S may restyle G.
    const want = expectedFolderCount('noneShared', 'adminUser', 'all');
    if ('refused' in want) throw new Error('the oracle refuses no scope of all');
    const counts = { itemCount: want.items, folderCount: want.folders };
    for (const [who, color] of [
      ['adminUser', 'red'],
      ['member', 'blue'],
    ] as const) {
      const res = await send(who, `/api/tree/notes/folders/${folder.noneShared}`, 'PATCH', {
        color,
      });
      expect(res.status, `${who}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      expect(res.body.folder, who).toMatchObject(counts);
      expect((await opened(who, 'all', folder.noneShared)).shown, who).toEqual(counts);
    }
    const out = (await mcpCall('adminUser', 'tree_folder_update', {
      kind: 'notes',
      folder_id: folder.noneShared,
      color: 'green',
    })) as Json;
    expect(out).toMatchObject({ id: folder.noneShared, ...counts });
    // A parent the caller does not read is no parent in the reply either,
    // as on the read path.
    const child = await send('adminUser', `/api/tree/notes/folders/${hOnly.child}`, 'PATCH', {
      color: 'red',
    });
    expect(child.status, JSON.stringify(child.body).slice(0, 200)).toBe(200);
    expect(child.body.folder).toMatchObject({ id: hOnly.child, parentId: null });
    expect((await get('adminUser', `/api/tree/notes?folder=${hOnly.child}`)).folder).toMatchObject({
      id: hOnly.child,
      parentId: null,
    });
    // A user of H reads the parent: it is named there.
    expect(
      (await get('adminUserInHome', `/api/tree/notes?folder=${hOnly.child}`)).folder.parentId,
    ).toBe(hOnly.parent);
  }, 60_000);

  it('a move’s confirm list names and counts only what the caller reads', async () => {
    // The Admin user moderates S: it may move `moved` into `dest`, which T
    // reads too. `hidden` would gain T as well, but it is not the caller's
    // to see.
    const res = await send('adminUser', `/api/tree/notes/folders/${mv.moved}`, 'PATCH', {
      parentId: mv.dest,
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(409);
    expect(res.body.error).toBe('visibility');
    const ids = (res.body.changes as Json[]).map((ch) => ch.id).sort();
    expect(ids).toEqual([mv.moved, mv.seen].sort());
    expect(res.body.total).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain('hidden note');
    // The system's own work has no scope: the same move names all three.
    const tree = await import('@mantle/content/tree');
    const diff = await tree.moveFolderDiff(
      owner,
      { id: mv.moved, path: `notes.${tag}_moved` },
      `notes.${tag}_dest`,
    );
    expect(diff.total).toBe(3);
  }, 60_000);

  it('the tag counts follow ?ws=', async () => {
    await x(sql`update nodes set tags = array['note', ${`${tag}t`}]
                 where owner_id = ${owner} and type = 'note'
                   and (path <@ ${pathOf.oneOfThree}::ltree or path <@ ${pathOf.noneShared}::ltree)`);
    const count = async (who: FolderCountCaller, scope: FolderCountScope) => {
      const body = await get(who, `/api/tree/notes/tags?x=1${wsQuery(scope)}`);
      return (body.tags as Json[]).find((t) => t.tag === `${tag}t`)?.count ?? 0;
    };
    // A user of H reads all six; S reads one of them.
    expect(await count('adminUserInHome', 'all')).toBe(6);
    expect(await count('adminUserInHome', 'S')).toBe(1);
    expect(await count('member', 'all')).toBe(1);
  }, 60_000);
});
