/**
 * The list chips and the `?ws=` filter (W5b2 contract changes 5 and 14),
 * through the real routes on a scratch brain the workspaces migration made
 * live (the owner check is stood in):
 *
 *  - every row of GET /api/pages and /api/notes, and every item and folder
 *    of GET /api/tree/:kind and its search, carries `workspaces` (live ones
 *    only, by name; all of them for an Admin user, only the caller's own
 *    for anyone else) and `hasLink` (an open link, not a revoked one);
 *  - each chip carries its workspace's look (task 5edc9149): colour, icon
 *    and kind, in a login's scope too; a stored value no client can draw
 *    goes out as null;
 *  - `?ws=<id>` keeps what that workspace reads and is echoed as `ws`; a
 *    workspace the caller may not name (unknown, archived, not a user of
 *    it, not an id) is 404 `not_found`.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/list-workspaces.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.user),
}));

type Json = Record<string, any>;

describe.skipIf(!URL)('list chips and ?ws= (W5b2)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let lw: typeof import('@/lib/list-workspaces');
  const owner = randomUUID();
  const mem = randomUUID();
  const P = randomUUID(); // the member's
  const Q = randomUUID(); // the owner's (an Admin user picks only its own)
  const N = randomUUID(); // nobody's: not even an Admin user names it
  const A = randomUUID(); // archived
  let admin = '';
  const ids = { folder: '', alpha: '', bravo: '', note1: '', note2: '' };

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const grant = (id: string, ws: string) =>
    m.withSubtreeHeads(id, [], async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id) values (${id}, ${ws})`);
    });
  const get = async (
    mod: { GET: (req: Request, ctx?: any) => Promise<Response> },
    path: string,
    params?: Json,
  ) => {
    const res = await mod.GET(
      new Request(`http://brain.test${path}`),
      params ? { params: Promise.resolve(params) } : undefined,
    );
    return { status: res.status, body: (await res.json()) as Json };
  };
  const byId = (rows: Json[]) => new Map(rows.map((r) => [r.id as string, r]));
  // Each chip by id and name; its look (task 5edc9149) is checked on its own.
  const ws = (...pairs: Array<[string, string]>) =>
    pairs.map(([id, name]) => expect.objectContaining({ id, name }));

  let routes: {
    pages: typeof import('@/app/api/pages/route');
    notes: typeof import('@/app/api/notes/route');
    tree: typeof import('@/app/api/tree/[kind]/route');
    search: typeof import('@/app/api/tree/[kind]/search/route');
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'list-chips-db-test-secret-at-least-32-characters';
    m = await import('@mantle/db');
    lw = await import('@/lib/list-workspaces');
    const email = (who: string) => `chips-${who}-${owner.slice(0, 8)}@example.invalid`;
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${email('owner')}, 'x', true, 'admin'),
      (${mem}, ${email('mem')}, 'x', false, 'member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
                on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    admin = (
      await x<{ id: string }>(
        sql`select id::text as id from workspaces where owner_id = ${owner} and is_admin`,
      )
    )[0]!.id;
    await x(sql`insert into workspaces (id, owner_id, name) values
      (${P}, ${owner}, 'Proj'), (${Q}, ${owner}, 'Quay'), (${A}, ${owner}, 'Attic'),
      (${N}, ${owner}, 'Nobody')`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${P}, ${mem}, false), (${Q}, ${owner}, false), (${A}, ${owner}, false)`);
    h.user = {
      id: owner,
      email: email('owner'),
      actor: { id: owner, email: email('owner'), displayName: null, isOwner: true },
    };

    const tree = await import('@mantle/content/tree');
    const pages = await import('@mantle/content/pages');
    const notes = await import('@mantle/content/notes');
    await tree.ensureKindRoot(owner, 'pages');
    const f = await tree.createTreeFolder(owner, 'pages', { parentId: null, name: 'Quay folder' });
    ids.folder = f.id;
    await grant(f.id, Q);
    ids.alpha = (
      await pages.createPage(owner, { title: 'Alpha', folderId: f.id, confirm: true })
    ).id;
    ids.bravo = (await pages.createPage(owner, { title: 'Bravo' })).id;
    ids.note1 = (await notes.createNote(owner, { title: 'Note one', content: 'x' })).id;
    ids.note2 = (await notes.createNote(owner, { title: 'Note two', content: 'y' })).id;
    await grant(ids.note1, Q);
    // An archived workspace's grant is not a chip.
    await grant(ids.bravo, A);
    await x(sql`update workspaces set archived_at = now() where id = ${A}`);
    // Bravo has an open link; Alpha only a revoked one.
    await x(sql`insert into shares (token, owner_id, node_id, node_type) values
      (${`tok-${randomUUID()}`}, ${owner}, ${ids.bravo}, 'page')`);
    await x(sql`insert into shares (token, owner_id, node_id, node_type, revoked_at) values
      (${`tok-${randomUUID()}`}, ${owner}, ${ids.alpha}, 'page', now())`);

    routes = {
      pages: await import('@/app/api/pages/route'),
      notes: await import('@/app/api/notes/route'),
      tree: await import('@/app/api/tree/[kind]/route'),
      search: await import('@/app/api/tree/[kind]/search/route'),
    };
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('pages: every row carries its workspaces and link; ?ws keeps what it reads and echoes it', async () => {
    const all = await get(routes.pages, '/api/pages');
    expect(all.status).toBe(200);
    expect(all.body).not.toHaveProperty('ws');
    const rows = byId(all.body.pages);
    expect(rows.get(ids.alpha)).toMatchObject({
      workspaces: ws([admin, 'Admin'], [Q, 'Quay']),
      hasLink: false,
    });
    expect(rows.get(ids.bravo)).toMatchObject({ workspaces: ws([admin, 'Admin']), hasLink: true });

    const inQ = await get(routes.pages, `/api/pages?ws=${Q}`);
    expect(inQ.body.ws).toBe(Q);
    expect(inQ.body.pages.map((r: Json) => r.id)).toEqual([ids.alpha]);
    // The flat, filtered list too.
    const listed = await get(routes.pages, `/api/pages?q=a&ws=${Q.toUpperCase()}`);
    expect(listed.body).toMatchObject({ mode: 'list', total: 1, ws: Q });
    expect(listed.body.pages.map((r: Json) => r.id)).toEqual([ids.alpha]);
    // Private rows are in no workspace.
    const priv = await get(routes.pages, `/api/pages?state=private&ws=${Q}`);
    expect(priv.body).toMatchObject({ pages: [], total: 0, ws: Q });
  }, 60_000);

  it('a workspace the caller may not name is 404 not_found', async () => {
    for (const bad of [randomUUID(), 'not-an-id', A, N]) {
      for (const path of [`/api/pages?ws=${bad}`, `/api/notes?ws=${bad}`]) {
        const mod = path.startsWith('/api/pages') ? routes.pages : routes.notes;
        expect(await get(mod, path)).toEqual({
          status: 404,
          body: { error: 'Workspace not found.', code: 'not_found' },
        });
      }
      const t = await get(routes.tree, `/api/tree/pages?ws=${bad}`, { kind: 'pages' });
      expect(t).toMatchObject({ status: 404, body: { code: 'not_found' } });
      const s = await get(routes.search, `/api/tree/pages/search?ws=${bad}`, { kind: 'pages' });
      expect(s).toMatchObject({ status: 404, body: { code: 'not_found' } });
    }
  });

  it('notes: the same chips and filter', async () => {
    const all = await get(routes.notes, '/api/notes');
    const rows = byId(all.body.notes);
    expect(rows.get(ids.note1)).toMatchObject({
      workspaces: ws([admin, 'Admin'], [Q, 'Quay']),
      hasLink: false,
    });
    expect(rows.get(ids.note2)).toMatchObject({ workspaces: ws([admin, 'Admin']) });
    const inQ = await get(routes.notes, `/api/notes?ws=${Q}`);
    expect(inQ.body).toMatchObject({ total: 1, ws: Q });
    expect(inQ.body.notes.map((r: Json) => r.id)).toEqual([ids.note1]);
  });

  it('the tree: folders and items carry chips; ?ws filters the items, keeps the folders', async () => {
    const root = await get(routes.tree, '/api/tree/pages', { kind: 'pages' });
    expect(root.status).toBe(200);
    expect(byId(root.body.folders).get(ids.folder)).toMatchObject({
      workspaces: ws([admin, 'Admin'], [Q, 'Quay']),
      hasLink: false,
    });
    const bravo = byId(root.body.items).get(ids.bravo);
    expect(bravo).toMatchObject({ workspaces: ws([admin, 'Admin']), hasLink: true });
    expect(bravo).not.toHaveProperty('level');

    const inside = await get(routes.tree, `/api/tree/pages?folder=${ids.folder}`, {
      kind: 'pages',
    });
    expect(inside.body.folder).toMatchObject({
      id: ids.folder,
      workspaces: ws([admin, 'Admin'], [Q, 'Quay']),
    });
    expect(inside.body.items).toEqual([
      expect.objectContaining({ id: ids.alpha, workspaces: ws([admin, 'Admin'], [Q, 'Quay']) }),
    ]);

    const rootQ = await get(routes.tree, `/api/tree/pages?ws=${Q}`, { kind: 'pages' });
    expect(rootQ.body.ws).toBe(Q);
    expect(rootQ.body.items).toEqual([]);
    expect(rootQ.body.folders.map((f: Json) => f.id)).toContain(ids.folder);
    const insideQ = await get(routes.tree, `/api/tree/pages?folder=${ids.folder}&ws=${Q}`, {
      kind: 'pages',
    });
    expect(insideQ.body.items.map((i: Json) => i.id)).toEqual([ids.alpha]);
  });

  it('the tree search: chips on folders and items; ?ws narrows the items, drops the folders', async () => {
    const byName = await get(routes.search, '/api/tree/pages/search?q=quay', { kind: 'pages' });
    expect(byName.body).not.toHaveProperty('ws');
    expect(byName.body.folders).toEqual([
      expect.objectContaining({ id: ids.folder, workspaces: ws([admin, 'Admin'], [Q, 'Quay']) }),
    ]);
    const az = await get(routes.search, `/api/tree/pages/search?ws=${Q}`, { kind: 'pages' });
    expect(az.body).toMatchObject({ folders: [], ws: Q });
    expect(az.body.items.map((i: Json) => [i.id, i.hasLink])).toEqual([[ids.alpha, false]]);
  });

  it('anyone not an Admin user sees only the chips and filters of its own workspaces', async () => {
    // The caps (W6b fix round 1) ride along: on the system pool, everything.
    expect((await lw.workspaceChips(owner, mem, [ids.alpha])).get(ids.alpha)).toEqual({
      workspaces: [],
      hasLink: false,
      mayEdit: true,
      mayManage: true,
    });
    await grant(ids.alpha, P);
    expect((await lw.workspaceChips(owner, mem, [ids.alpha])).get(ids.alpha)).toEqual({
      workspaces: [{ id: P, name: 'Proj', color: null, icon: null, kind: 'other' }],
      hasLink: false,
      mayEdit: true,
      mayManage: true,
    });
    const req = (w: string) => new Request(`http://brain.test/api/pages?ws=${w}`);
    expect(await lw.parseWsFilter(req(P), owner, mem)).toBe(P);
    const refused = await lw.parseWsFilter(req(Q), owner, mem);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(404);
    expect(await lw.parseWsFilter(new Request('http://brain.test/api/pages'), owner, mem)).toBe(
      null,
    );
  });

  it('a chip carries its workspace look, in a login scope too (task 5edc9149)', async () => {
    await x(sql`update workspaces set color = 'teal', icon = 'lucide:rocket' where id = ${Q}`);
    expect((await lw.workspaceChips(owner, owner, [ids.note1])).get(ids.note1)!.workspaces).toEqual(
      [
        { id: admin, name: 'Admin', color: null, icon: null, kind: 'admin' },
        { id: Q, name: 'Quay', color: 'teal', icon: 'lucide:rocket', kind: 'other' },
      ],
    );
    // The member's private workspace and the Team workspace, read in the
    // member's own scope (mantle_ws_kind reads private_workspaces for it).
    const PV = randomUUID();
    // A Team as a brain switched before 0286 has it (a new brain has none).
    const team = (await x<{ id: string }>(sql.raw(teamWorkspaceSql(owner))))[0]!.id;
    await x(
      sql`insert into workspaces (id, owner_id, name) values (${PV}, ${owner}, 'Mine (only you)')`,
    );
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values (${PV}, ${mem}, true)
                on conflict do nothing`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values (${team}, ${mem}, false)
                on conflict do nothing`);
    await x(sql`insert into private_workspaces (login_id, workspace_id) values (${mem}, ${PV})
                on conflict (login_id) do update set workspace_id = excluded.workspace_id`);
    await grant(ids.note2, PV);
    await grant(ids.note2, team);
    // A stored value no client can draw goes out as the default.
    await x(sql`update workspaces set color = 'mauve', icon = 'not an icon' where id = ${team}`);
    const scoped = await m.withViewer({ login: mem }, () =>
      lw.workspaceChips(owner, mem, [ids.note2]),
    );
    const kinds = Object.fromEntries(
      scoped.get(ids.note2)!.workspaces.map((w) => [w.id, [w.kind, w.color, w.icon]]),
    );
    // Team is 'other' since 0286 (no built-in Team kind).
    expect(kinds).toEqual({ [PV]: ['private', null, null], [team]: ['other', null, null] });
  });
});
