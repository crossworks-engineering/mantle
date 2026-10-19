/**
 * Pages in the item tree (folder phase 7), against a real, migrated
 * Postgres: a page is made in a folder (never under a page), split and
 * extract land next to the source, a member files a page draft where its
 * tree shows, and the page detail names its folder. The confirm before a
 * page reaches another workspace (made in or moved into a folder) is
 * tree-grants-confirm.db.test.ts (W5b2: grants decide).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree-pages.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('pages in the item tree', () => {
  type Db = typeof import('@mantle/db');
  type Tree = typeof import('./index');
  type Pages = typeof import('../pages');
  let m: Db;
  let tree: Tree;
  let pages: Pages;
  let sqlTag: typeof import('drizzle-orm').sql;
  let brain = '';
  const member = randomUUID();
  /** A workspace of the member's, on the shared anchor. */
  const readers = randomUUID();
  let space = '';
  const label = `pages_${randomUUID().slice(0, 8)}`;
  const own = async (id: string) =>
    (
      (await m.systemDb.execute(sqlTag`
        select path::text as path, parent_id from nodes where id = ${id}`)) as unknown as Array<{
        path: string;
        parent_id: string | null;
      }>
    )[0] ?? null;
  const made: string[] = [];

  /** A fixture write to the workspace tables, as the superuser: the app's
   *  pools only read them. */
  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(URL!, q);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./index');
    pages = await import('../pages');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await tree.ensureKindRoot(brain, 'pages');
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${member}, ${`${label}@example.invalid`}, 'x', 'member')`);
    const [row] = (await m.systemDb.execute(sqlTag`
      select id::text as id from spaces where login_id = ${member} and kind = 'personal'`)) as unknown as Array<{
      id: string;
    }>;
    space = row!.id;
  }, 60_000);

  afterAll(async () => {
    if (space) await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${space}`);
    await m.systemDb.execute(sqlTag`
      delete from nodes where owner_id = ${brain}
         and (path <@ ${`pages.${label}`}::ltree or path <@ ${`pages.${label}_shared`}::ltree
              or id in (${sqlTag.join(
                [...made, randomUUID()].map((id) => sqlTag`${id}::uuid`),
                sqlTag`, `,
              )}))`);
    await su(sqlTag`delete from workspaces where id = ${readers}`);
    if (space) await m.systemDb.execute(sqlTag`delete from spaces where id = ${space}`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id = ${member}`);
  });

  it('makes a page in a folder, never under a page; the detail names the folder', async () => {
    const plans = await tree.createTreeFolder(brain, 'pages', { parentId: null, name: label });
    const page = await pages.createPage(brain, { title: 'Roadmap', folderId: plans.id });
    made.push(page.id);
    expect(await own(page.id)).toMatchObject({ path: plans.path, parent_id: null });
    expect((await pages.getPage(brain, page.id))?.folderId).toBe(plans.id);
    // The deprecated parentId means "the same folder as that page".
    const beside = await pages.createPage(brain, { title: 'Beside', parentId: page.id });
    made.push(beside.id);
    expect(await own(beside.id)).toMatchObject({ path: plans.path, parent_id: null });
    // The top level: no folder, folderId null in the detail.
    const top = await pages.createPage(brain, { title: 'Top' });
    made.push(top.id);
    expect(await own(top.id)).toMatchObject({ path: 'pages', parent_id: null });
    expect((await pages.getPage(brain, top.id))?.folderId).toBeNull();
    // The root's own row is not a folder; a random id is none either.
    const [root] = (await m.systemDb.execute(sqlTag`
      select id from nodes where owner_id = ${brain} and type = 'branch' and path = 'pages'::ltree`)) as unknown as Array<{
      id: string;
    }>;
    await expect(
      pages.createPage(brain, { title: 'x', folderId: root!.id }),
    ).rejects.toBeInstanceOf(pages.PageFolderNotFoundError);
    await expect(
      pages.createPage(brain, { title: 'x', folderId: randomUUID() }),
    ).rejects.toBeInstanceOf(pages.PageFolderNotFoundError);
    await expect(
      pages.createPage(brain, { title: 'x', parentId: randomUUID() }),
    ).rejects.toBeInstanceOf(pages.ParentPageNotFoundError);
    // The tree lists it, as an item, in that folder.
    const listed = await tree.loadTreeFolder(brain, 'pages', { folderId: plans.id });
    expect(listed!.items.map((i) => i.id)).toEqual(expect.arrayContaining([page.id, beside.id]));
  });

  it('a folder share is refused, and a page made in the folder asks nothing', async () => {
    const shared = await tree.createTreeFolder(brain, 'pages', {
      parentId: null,
      name: `${label} shared`,
    });
    await expect(
      tree.updateTreeFolder(brain, 'pages', shared.id, { share: 'client' }, { confirm: true }),
    ).rejects.toMatchObject({ name: 'TreeError', code: 'gone' });
    const page = await pages.createPage(brain, { title: 'Plain', folderId: shared.id });
    made.push(page.id);
    expect(await own(page.id)).toMatchObject({ path: shared.path });
  });

  it('split and extract make pages next to the source, in its folder', async () => {
    const [plans] = (await m.systemDb.execute(sqlTag`
      select id, path::text as path from nodes where owner_id = ${brain} and type = 'branch'
         and path = ${`pages.${label}`}::ltree`)) as unknown as Array<{ id: string; path: string }>;
    const heading = (id: string, text: string) => ({
      type: 'heading',
      attrs: { level: 1, id },
      content: [{ type: 'text', text }],
    });
    const para = (id: string, text: string) => ({
      type: 'paragraph',
      attrs: { id },
      content: [{ type: 'text', text }],
    });
    const doc = {
      type: 'doc',
      content: [
        heading('h_1', 'One'),
        para('p_1', 'one'),
        heading('h_2', 'Two'),
        para('p_2', 'two'),
      ],
    };
    const source = await pages.createPage(brain, { title: 'Long', doc, folderId: plans!.id });
    made.push(source.id);
    const split = await pages.splitPage(brain, source.id, { by: 1 });
    expect(split.children).toHaveLength(2);
    for (const c of split.children) {
      made.push(c.id);
      expect(await own(c.id)).toMatchObject({ path: plans!.path, parent_id: null });
    }
    const again = await pages.createPage(brain, { title: 'Long two', doc, folderId: plans!.id });
    made.push(again.id);
    const lifted = await pages.extractSectionToPage(brain, again.id, 'h_2');
    made.push(lifted.childId);
    expect(await own(lifted.childId)).toMatchObject({ path: plans!.path, parent_id: null });
  });
});
