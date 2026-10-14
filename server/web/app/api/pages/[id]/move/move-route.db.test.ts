/**
 * POST /api/pages/:id/move (folder phase 7) against a real, migrated
 * Postgres: files a page in a folder through the tree's item move, reads
 * the deprecated `parentId` as "the same folder as that page", refuses a
 * page as its own neighbour, and answers 409 `visibility` with the list
 * for a move into a folder another workspace reads until confirmed (W5b2:
 * the workspaces it would reach). Only the owner check is stubbed. On a
 * scratch brain the workspaces migration made live.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run move-route.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', () => ({
  getOwnerOr401: vi.fn(async () => ({ id: h.owner })),
  // The reader a converted handler calls (A4 step 3b): the same stand-in.
  ownerCaller: vi.fn(() => ({ id: h.owner })),
}));

describe.skipIf(!URL)('POST /api/pages/:id/move, on Postgres', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  const S = randomUUID();
  let route: typeof import('./route');
  let tree: typeof import('@mantle/content/tree');
  let pages: typeof import('@mantle/content/pages');
  let sqlTag: typeof import('drizzle-orm').sql;
  const label = `move_${randomUUID().slice(0, 8)}`;
  const ids = { a: '', b: '', c: '' };
  let plans = '';
  let shared = '';

  const post = (id: string, body: unknown) =>
    route.POST(
      new Request(`http://brain.test/api/pages/${id}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  const pathOf = async (id: string) =>
    (
      (await m.systemDb.execute(
        sqlTag`select path::text as path from nodes where id = ${id}`,
      )) as unknown as Array<{
        path: string;
      }>
    )[0]?.path;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    route = await import('./route');
    tree = await import('@mantle/content/tree');
    pages = await import('@mantle/content/pages');
    sqlTag = (await import('drizzle-orm')).sql;
    h.owner = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, is_owner, role)
      values (${h.owner}, ${`${label}@example.invalid`}, 'x', true, 'admin')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${h.owner}, 'brain', ${h.owner})
      on conflict (id) do nothing`);
    await m.systemDb.execute(sqlTag`select * from mantle_ws_migrate()`);
    await m.systemDb.execute(sqlTag`
      insert into workspaces (id, owner_id, name) values (${S}, ${h.owner}, 'Sales')`);
    await tree.ensureKindRoot(h.owner, 'pages');
    plans = (await tree.createTreeFolder(h.owner, 'pages', { parentId: null, name: label })).id;
    const s = await tree.createTreeFolder(h.owner, 'pages', {
      parentId: null,
      name: `${label} shared`,
    });
    shared = s.id;
    await m.withSubtreeHeads(shared, [], async (tx) => {
      await tx.execute(sqlTag`insert into item_grants (node_id, workspace_id)
                              values (${shared}, ${S})`);
    });
    ids.a = (await pages.createPage(h.owner, { title: 'A' })).id;
    ids.b = (await pages.createPage(h.owner, { title: 'B', folderId: plans })).id;
    ids.c = (await pages.createPage(h.owner, { title: 'C' })).id;
  }, 60_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('files the page in folderId, and answers the page with its folder', async () => {
    const res = await post(ids.a, { folderId: plans });
    expect(res.status).toBe(200);
    expect((await res.json()).page).toMatchObject({ id: ids.a, folderId: plans, parentId: null });
    expect(await pathOf(ids.a)).toBe(`pages.${label}`);
    const back = await post(ids.a, { folderId: null });
    expect(back.status).toBe(200);
    expect(await pathOf(ids.a)).toBe('pages');
  });

  it('reads the deprecated parentId as "the same folder as that page"', async () => {
    const res = await post(ids.c, { parentId: ids.b });
    expect(res.status).toBe(200);
    expect(await pathOf(ids.c)).toBe(`pages.${label}`);
    expect((await post(ids.c, { parentId: null })).status).toBe(200);
    expect(await pathOf(ids.c)).toBe('pages');
    expect((await post(ids.c, { parentId: ids.c })).status).toBe(400);
    expect((await post(ids.c, { parentId: randomUUID() })).status).toBe(400);
    expect((await post(ids.c, {})).status).toBe(400);
    expect((await post(randomUUID(), { folderId: null })).status).toBe(404);
  });

  it('answers 409 visibility for a move into a folder Sales reads, then moves once confirmed', async () => {
    const refused = await post(ids.c, { folderId: shared });
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body).toMatchObject({
      error: 'visibility',
      total: 1,
      changes: [{ id: ids.c, alsoVisibleTo: [{ wsId: S, name: 'Sales' }], removedFrom: [] }],
    });
    expect(await pathOf(ids.c)).toBe('pages');
    const ok = await post(ids.c, { folderId: shared, confirm: true, seen: body.total });
    expect(ok.status).toBe(200);
    expect((await ok.json()).page).toMatchObject({ folderId: shared });
    expect(await pathOf(ids.c)).toBe(`pages.${label}_shared`);
  });
});
