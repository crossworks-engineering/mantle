/**
 * POST /api/pages/:id/move (folder phase 7) against a real, migrated
 * Postgres: files a page in a folder through the tree's item move, reads
 * the deprecated `parentId` as "the same folder as that page", refuses a
 * page as its own neighbour, and answers 409 `visibility` with the list
 * for a move into a shared folder until confirmed. Only the owner check is
 * stubbed. Seeds its own rows under the shared test anchor and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run move-route.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', () => ({ getOwnerOr401: vi.fn(async () => ({ id: h.owner })) }));

describe.skipIf(!URL)('POST /api/pages/:id/move, on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
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
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    route = await import('./route');
    tree = await import('@mantle/content/tree');
    pages = await import('@mantle/content/pages');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    h.owner = await ensureTestAnchor(admin);
    await tree.ensureKindRoot(h.owner, 'pages');
    plans = (await tree.createTreeFolder(h.owner, 'pages', { parentId: null, name: label })).id;
    const s = await tree.createTreeFolder(h.owner, 'pages', {
      parentId: null,
      name: `${label} shared`,
    });
    shared = s.id;
    await tree.updateTreeFolder(h.owner, 'pages', shared, { share: 'client' }, { confirm: true });
    ids.a = (await pages.createPage(h.owner, { title: 'A' })).id;
    ids.b = (await pages.createPage(h.owner, { title: 'B', folderId: plans })).id;
    ids.c = (await pages.createPage(h.owner, { title: 'C' })).id;
  });

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`
      delete from nodes where owner_id = ${h.owner}
         and (id in (${ids.a}, ${ids.b}, ${ids.c}, ${plans}, ${shared})
              or path <@ ${`pages.${label}`}::ltree or path <@ ${`pages.${label}_shared`}::ltree)`);
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

  it('answers 409 visibility for a move into a shared folder, then moves once confirmed', async () => {
    const refused = await post(ids.c, { folderId: shared });
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body).toMatchObject({
      error: 'visibility',
      total: 1,
      changes: [{ id: ids.c, from: 'admin', to: 'client' }],
    });
    expect(await pathOf(ids.c)).toBe('pages');
    const ok = await post(ids.c, { folderId: shared, confirm: true, seen: body.total });
    expect(ok.status).toBe(200);
    expect((await ok.json()).page).toMatchObject({ folderId: shared });
    expect(await pathOf(ids.c)).toBe(`pages.${label}_shared`);
  });
});
