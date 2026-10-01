/**
 * Pages in the item tree (folder phase 7), against a real, migrated
 * Postgres: a page is made in a folder (never under a page), a page made in
 * a shared folder asks first and lists what it opens, a page move asks
 * like a note's, split and extract land next to the source, a member files
 * a page draft where its tree shows, and the page detail names its folder.
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
  let space = '';
  const label = `pages_${randomUUID().slice(0, 8)}`;
  const own = async (id: string) =>
    (
      (await m.systemDb.execute(sqlTag`
        select path::text as path, parent_id, audience, inherited_level, embedded_level
          from nodes where id = ${id}`)) as unknown as Array<{
        path: string;
        parent_id: string | null;
        audience: string;
        inherited_level: string | null;
        embedded_level: string | null;
      }>
    )[0] ?? null;
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      if (err instanceof tree.TreeVisibilityError) return err.diff;
      throw err;
    }
    throw new Error('expected a visibility refusal');
  };
  const made: string[] = [];

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
  });

  afterAll(async () => {
    if (space) await m.systemDb.execute(sqlTag`delete from nodes where owner_id = ${space}`);
    await m.systemDb.execute(sqlTag`
      delete from nodes where owner_id = ${brain}
         and (path <@ ${`pages.${label}`}::ltree or path <@ ${`pages.${label}_shared`}::ltree
              or id in (${sqlTag.join(
                [...made, randomUUID()].map((id) => sqlTag`${id}::uuid`),
                sqlTag`, `,
              )}))`);
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

  it('a page made in a shared folder asks first, and lists what its document opens', async () => {
    const shared = await tree.createTreeFolder(brain, 'pages', {
      parentId: null,
      name: `${label} shared`,
    });
    await tree.updateTreeFolder(brain, 'pages', shared.id, { share: 'client' }, { confirm: true });
    const pic = randomUUID();
    made.push(pic);
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data, tags)
      values (${pic}, ${brain}, 'file', 'private.png', 'files'::ltree, '{}'::jsonb, '{}')`);
    const doc = { type: 'doc', content: [{ type: 'image', attrs: { nodeId: pic, src: 'x' } }] };
    const diff = await refusal(
      pages.createPage(brain, { title: 'Leaky', doc, folderId: shared.id }),
    );
    expect(diff.total).toBe(1);
    expect(diff.changes[0]).toMatchObject({ title: 'Leaky', from: 'admin', to: 'client' });
    expect(diff.alsoEmbeds?.map((c) => c.id)).toEqual([pic]);
    expect(diff.alsoEmbeds?.[0]).toMatchObject({ from: 'admin', to: 'client', type: 'file' });
    expect(diff.embedsTotal).toBe(1);
    // Nothing was written, the picture is still private.
    expect(await own(pic)).toMatchObject({ embedded_level: null });
    const listed = await tree.loadTreeFolder(brain, 'pages', { folderId: shared.id });
    expect(listed!.items).toEqual([]);
    // A confirm for another count is refused again; the right one goes ahead.
    await refusal(
      pages.createPage(brain, { title: 'Leaky', doc, folderId: shared.id, confirm: true, seen: 1 }),
    );
    const page = await pages.createPage(brain, {
      title: 'Leaky',
      doc,
      folderId: shared.id,
      confirm: true,
      seen: 2,
    });
    made.push(page.id);
    expect(await own(page.id)).toMatchObject({ path: shared.path, inherited_level: 'client' });
    expect(await own(pic)).toMatchObject({ audience: 'admin', embedded_level: 'client' });
  });

  it('a page move asks like a note’s: refused, then confirmed', async () => {
    const [shared] = (await m.systemDb.execute(sqlTag`
      select id from nodes where owner_id = ${brain} and type = 'branch'
         and path = ${`pages.${label}_shared`}::ltree`)) as unknown as Array<{ id: string }>;
    const page = await pages.createPage(brain, { title: 'Mover' });
    made.push(page.id);
    const shown = await refusal(tree.moveTreeItems(brain, 'pages', [page.id], shared!.id));
    expect(shown.changes[0]).toMatchObject({ id: page.id, from: 'admin', to: 'client' });
    expect(await own(page.id)).toMatchObject({ path: 'pages', inherited_level: null });
    await tree.moveTreeItems(brain, 'pages', [page.id], shared!.id, {
      confirm: true,
      seen: shown.total,
    });
    expect(await own(page.id)).toMatchObject({ inherited_level: 'client' });
    expect((await pages.getPage(brain, page.id))?.folderId).toBe(shared!.id);
    await refusal(tree.moveTreeItems(brain, 'pages', [page.id], null));
    await tree.moveTreeItems(brain, 'pages', [page.id], null, { confirm: true });
    expect(await own(page.id)).toMatchObject({ path: 'pages', inherited_level: null });
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

  it('a draft-only embed of the source is asked about when a section is lifted next to it', async () => {
    const [shared] = (await m.systemDb.execute(sqlTag`
      select id from nodes where owner_id = ${brain} and type = 'branch'
         and path = ${`pages.${label}_shared`}::ltree`)) as unknown as Array<{ id: string }>;
    // The source sits in the client-shared folder with an empty published doc.
    const source = await pages.createPage(brain, {
      title: 'Draft source',
      folderId: shared!.id,
      confirm: true,
      seen: 1,
    });
    made.push(source.id);
    // A private picture pasted into its DRAFT only: 0208 reads the published
    // doc, so nothing is open yet.
    const pic = randomUUID();
    made.push(pic);
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data, tags)
      values (${pic}, ${brain}, 'file', 'draft-only.png', 'files'::ltree, '{}'::jsonb, '{}')`);
    await pages.saveDraft(brain, source.id, {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1, id: 'h_1' },
          content: [{ type: 'text', text: 'Pics' }],
        },
        { type: 'image', attrs: { id: 'i_1', nodeId: pic, src: 'x' } },
      ],
    });
    expect(await own(pic)).toMatchObject({ embedded_level: null });
    const diff = await refusal(pages.extractSectionToPage(brain, source.id, 'h_1'));
    // The new page's own row is not asked about (its source shows there
    // already); the picture it would open is.
    expect(diff.total).toBe(0);
    expect(diff.alsoEmbeds?.map((c) => c.id)).toEqual([pic]);
    expect(await own(pic)).toMatchObject({ embedded_level: null });
    const lifted = await pages.extractSectionToPage(brain, source.id, 'h_1', { confirm: true });
    made.push(lifted.childId);
    expect(await own(lifted.childId)).toMatchObject({ path: `pages.${label}_shared` });
    expect(await own(pic)).toMatchObject({ audience: 'admin', embedded_level: 'client' });
  });

  it('a member files a page draft where its tree shows, never in a hidden brain folder', async () => {
    const scope = { anchorId: brain, spaceId: space, loginId: member };
    // A brain folder shared with the team: the member sees it.
    const [shared] = (await m.systemDb.execute(sqlTag`
      select id from nodes where owner_id = ${brain} and type = 'branch'
         and path = ${`pages.${label}_shared`}::ltree`)) as unknown as Array<{ id: string }>;
    await m.systemDb.execute(
      sqlTag`update nodes set share_level = 'team' where id = ${shared!.id}`,
    );
    const at = await tree.memberFilingPath(scope, 'pages', shared!.id);
    expect(at).toBe(`pages.${label}_shared`);
    // Its own folder in it, and a draft filed there.
    const mine = await tree.createMemberFolder(scope, 'pages', {
      parentId: shared!.id,
      name: 'Mine',
    });
    expect(await tree.memberFilingPath(scope, 'pages', mine.id)).toBe(`pages.${label}_shared.mine`);
    // A brain folder it does not see (admin only) is not a place.
    const [hidden] = (await m.systemDb.execute(sqlTag`
      select id from nodes where owner_id = ${brain} and type = 'branch'
         and path = ${`pages.${label}`}::ltree`)) as unknown as Array<{ id: string }>;
    await expect(tree.memberFilingPath(scope, 'pages', hidden!.id)).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
