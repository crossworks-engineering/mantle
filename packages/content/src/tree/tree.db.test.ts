/**
 * The item tree on Files, against a real, migrated Postgres and a temporary
 * files root (docs/folder-tree.md):
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the item tree on Files', () => {
  type Db = typeof import('@mantle/db');
  type Tree = typeof import('./index');
  type Files = typeof import('@mantle/files');
  let m: Db;
  let tree: Tree;
  let files: Files;
  let sqlTag: typeof import('drizzle-orm').sql;
  let root: string;
  let prevRoot: string | undefined;
  const owner = randomUUID();
  const actor = randomUUID();
  const tag = `tree-test-${owner.slice(0, 8)}`;

  const upload = (parentPath: string, filename: string) =>
    files.upsertFile({ ownerId: owner, parentPath, filename, bytes: Buffer.from(filename) });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-tree-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    tree = await import('./index');
    files = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await files.ensureFilesRootBranch(owner);
  });

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from item_marks where actor_id = ${actor}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('creates folders with a display name and a slug path, three levels deep at most', async () => {
    const clients = await tree.createTreeFolder(owner, 'files', {
      parentId: null,
      name: 'Acme Corp',
      icon: 'lucide:briefcase',
      color: 'cyan',
    });
    expect(clients).toMatchObject({
      name: 'Acme Corp',
      path: 'files.acme_corp',
      depth: 1,
      parentId: null,
      icon: 'lucide:briefcase',
      color: 'cyan',
    });
    expect((await stat(path.join(root, 'acme-corp'))).isDirectory()).toBe(true);

    const a = await tree.createTreeFolder(owner, 'files', {
      parentId: clients.id,
      name: 'Contracts',
      // An empty icon and a null colour are "none": nothing stored.
      icon: '',
      color: null,
    });
    expect(a).toMatchObject({ icon: null, color: null });
    const b = await tree.createTreeFolder(owner, 'files', { parentId: a.id, name: '2026' });
    expect(b).toMatchObject({ depth: 3, parentId: a.id });
    await expect(
      tree.createTreeFolder(owner, 'files', { parentId: b.id, name: 'Too deep' }),
    ).rejects.toThrow(/deeper than 3/);
  });

  it('refuses a fourth level in the database too', async () => {
    const err = await m.db
      .execute(
        sqlTag`insert into nodes (owner_id, type, title, slug, path)
               values (${owner}, 'branch', 'x', 'x', 'files.a.b.c.d'::ltree)`,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    const cause = (err as { cause?: { constraint_name?: string } } | null)?.cause;
    expect(cause?.constraint_name).toBe('nodes_tree_folder_depth_ck');
  });

  it('pages a folder by cursor without gaps or repeats', async () => {
    const f = await tree.createTreeFolder(owner, 'files', { parentId: null, name: 'Paged' });
    for (const n of ['e.txt', 'a.txt', 'd.txt', 'c.txt', 'b.txt']) await upload(f.path, n);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page = await tree.loadTreeFolder(owner, 'files', {
        folderId: f.id,
        sort: 'name',
        limit: 2,
        cursor,
      });
      seen.push(...page!.items.map((it) => it.title));
      cursor = page!.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
    const first = await tree.loadTreeFolder(owner, 'files', { folderId: f.id });
    expect(first!.items[0]).toMatchObject({ subtype: 'txt', level: 'admin', state: null });
  });

  it('lists subfolders with counts and crumbs', async () => {
    const top = await tree.loadTreeFolder(owner, 'files');
    const acme = top!.folders.find((f) => f.name === 'Acme Corp')!;
    expect(acme).toMatchObject({ folderCount: 1, itemCount: 0 });
    const contracts = (await tree.loadTreeFolder(owner, 'files', { folderId: acme.id }))!
      .folders[0]!;
    const deep = await tree.loadTreeFolder(owner, 'files', { folderId: contracts.id });
    expect(deep!.crumbs).toEqual([{ id: acme.id, name: 'Acme Corp' }]);
    expect(await tree.loadTreeFolder(owner, 'files', { folderId: randomUUID() })).toBeNull();
  });

  it('renames: a new casing keeps the path, a new name moves the folder on disk', async () => {
    const f = await tree.createTreeFolder(owner, 'files', { parentId: null, name: 'ideas' });
    const recased = await tree.updateTreeFolder(owner, 'files', f.id, { name: 'Ideas' });
    expect(recased).toMatchObject({ name: 'Ideas', path: 'files.ideas' });
    const renamed = await tree.updateTreeFolder(owner, 'files', f.id, { name: 'Business Ideas' });
    expect(renamed).toMatchObject({ name: 'Business Ideas', path: 'files.business_ideas' });
    expect((await stat(path.join(root, 'business-ideas'))).isDirectory()).toBe(true);
  });

  it('keeps a manual folder order', async () => {
    const top = await tree.loadTreeFolder(owner, 'files');
    const names = top!.folders.map((f) => f.name);
    const last = top!.folders.at(-1)!;
    await tree.updateTreeFolder(owner, 'files', last.id, { after: null });
    const again = await tree.loadTreeFolder(owner, 'files');
    expect(again!.folders[0]!.id).toBe(last.id);
    expect(again!.folders.map((f) => f.name).sort()).toEqual([...names].sort());
  });

  it('searches folders and items, with where they live', async () => {
    const res = await tree.searchTree(owner, 'files', 'c.t');
    expect(res.items.map((i) => i.title)).toEqual(['c.txt']);
    expect(res.items[0]!.crumbs.map((c) => c.name)).toEqual(['Paged']);
    const folders = await tree.searchTree(owner, 'files', 'contract');
    expect(folders.folders.map((f) => f.name)).toEqual(['Contracts']);
    expect(folders.folders[0]!.crumbs.map((c) => c.name)).toEqual(['Acme Corp']);
    expect((await tree.searchTree(owner, 'files', '%')).items).toEqual([]);
  });

  it('lists every item by name for an empty search, and no folders (A to Z)', async () => {
    const all = await tree.searchTree(owner, 'files', '  ');
    expect(all.folders).toEqual([]);
    const titles = all.items.map((i) => i.title);
    expect(titles).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
    expect(all.items[0]!.crumbs.map((c) => c.name)).toEqual(['Paged']);
    const first = await tree.searchTree(owner, 'files', '', { limit: 3 });
    expect(first.items.map((i) => i.title)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    const rest = await tree.searchTree(owner, 'files', '', { cursor: first.nextCursor, limit: 3 });
    expect(rest.folders).toEqual([]);
    expect(rest.items.map((i) => i.title)).toEqual(['d.txt', 'e.txt']);
    expect(rest.nextCursor).toBeNull();
  });

  it('filters items by level and tag, without folders, and lists the tags in use', async () => {
    await m.db.execute(sqlTag`
      update nodes set tags = array_append(tags, 'invoice'), audience = 'team'
       where owner_id = ${owner} and type = 'file' and title in ('b.txt', 'd.txt')`);
    await m.db.execute(sqlTag`
      update nodes set tags = array_append(tags, 'invoice')
       where owner_id = ${owner} and type = 'file' and title = 'e.txt'`);
    const titles = (r: { items: Array<{ title: string }> }) => r.items.map((i) => i.title);
    const byTag = await tree.searchTree(owner, 'files', '', { tag: 'invoice' });
    expect(titles(byTag)).toEqual(['b.txt', 'd.txt', 'e.txt']);
    const byLevel = await tree.searchTree(owner, 'files', '', { level: 'team' });
    expect(titles(byLevel)).toEqual(['b.txt', 'd.txt']);
    expect(byLevel.items[0]!.level).toBe('team');
    const both = await tree.searchTree(owner, 'files', 'd', { tag: 'invoice', level: 'team' });
    expect(titles(both)).toEqual(['d.txt']);
    // "Paged" matches a term that a folder would; a filtered search has none.
    const withTerm = await tree.searchTree(owner, 'files', 'pag', { tag: 'invoice' });
    expect(withTerm.folders).toEqual([]);
    const tags = await tree.listTreeTags(owner, 'files');
    expect(tags.tags[0]).toEqual({ tag: 'invoice', count: 3 });
    expect(tags.tags.map((t) => t.tag)).not.toContain('file');
  });

  it('moves items and deletes a folder by lifting what it holds', async () => {
    const box = await tree.createTreeFolder(owner, 'files', { parentId: null, name: 'Box' });
    const inner = await tree.createTreeFolder(owner, 'files', { parentId: box.id, name: 'Inner' });
    const file = await upload(inner.path, 'keep.md');
    await tree.deleteTreeFolder(owner, 'files', inner.id);
    const boxPage = await tree.loadTreeFolder(owner, 'files', { folderId: box.id });
    expect(boxPage!.items.map((i) => i.id)).toEqual([file.id]);
    const moved = await tree.moveTreeItems(owner, 'files', [file.id], null);
    expect(moved).toEqual({ moved: 1, failed: [] });
    const rootPage = await tree.loadTreeFolder(owner, 'files');
    expect(rootPage!.items.map((i) => i.id)).toContain(file.id);
  });

  it('a delete merges a clashing subfolder, recursively, and renames a clashing file', async () => {
    const proj = await tree.createTreeFolder(owner, 'files', { parentId: null, name: 'Proj' });
    await tree.updateTreeFolder(owner, 'files', proj.id, { icon: 'lucide:star' });
    const specs = await tree.createTreeFolder(owner, 'files', {
      parentId: proj.id,
      name: 'Specs',
    });
    await upload(proj.path, 'readme.md');
    await upload(specs.path, 'a.md');
    const box = await tree.createTreeFolder(owner, 'files', { parentId: null, name: 'Crate box' });
    const boxProj = await tree.createTreeFolder(owner, 'files', { parentId: box.id, name: 'Proj' });
    const boxSpecs = await tree.createTreeFolder(owner, 'files', {
      parentId: boxProj.id,
      name: 'Specs',
    });
    const extra = await tree.createTreeFolder(owner, 'files', {
      parentId: boxProj.id,
      name: 'Extra',
    });
    const readme2 = await upload(boxProj.path, 'readme.md');
    const a2 = await upload(boxSpecs.path, 'a.md');
    const b = await upload(boxSpecs.path, 'b.md');
    const loose = await upload(box.path, 'loose.md');

    await tree.deleteTreeFolder(owner, 'files', box.id);

    // The folder that was there keeps its id, name and look; the merged
    // ones are gone, and the one that did not clash moved up whole.
    const kept = (await tree.loadTreeFolder(owner, 'files', { folderId: proj.id }))!;
    expect(kept.folder).toMatchObject({ id: proj.id, name: 'Proj', icon: 'lucide:star' });
    expect(kept.folders.map((f) => f.id).sort()).toEqual([extra.id, specs.id].sort());
    expect(await tree.loadTreeFolder(owner, 'files', { folderId: boxProj.id })).toBeNull();
    expect(await tree.loadTreeFolder(owner, 'files', { folderId: boxSpecs.id })).toBeNull();
    expect(await tree.loadTreeFolder(owner, 'files', { folderId: box.id })).toBeNull();
    // Clashing files took the -2 name; the rest kept theirs.
    const titles = async (id: string) =>
      (await tree.loadTreeFolder(owner, 'files', { folderId: id }))!.items.map((i) => [
        i.id,
        i.title,
      ]);
    expect(await titles(proj.id)).toContainEqual([readme2.id, 'readme-2.md']);
    expect(await titles(specs.id)).toEqual(
      expect.arrayContaining([
        [a2.id, 'a-2.md'],
        [b.id, 'b.md'],
      ]),
    );
    expect((await tree.loadTreeFolder(owner, 'files'))!.items.map((i) => i.id)).toContain(loose.id);
    // And on disk.
    expect((await stat(path.join(root, 'proj', 'readme-2.md'))).isFile()).toBe(true);
    expect((await stat(path.join(root, 'proj', 'specs', 'a-2.md'))).isFile()).toBe(true);
    expect((await stat(path.join(root, 'proj', 'specs', 'b.md'))).isFile()).toBe(true);
    expect((await stat(path.join(root, 'proj', 'extra'))).isDirectory()).toBe(true);
    expect((await stat(path.join(root, 'loose.md'))).isFile()).toBe(true);
    await expect(stat(path.join(root, 'crate-box'))).rejects.toThrow(/ENOENT/);
  });

  it('a subfolder named like the deleted folder takes its place', async () => {
    const twin = await tree.createTreeFolder(owner, 'files', { parentId: null, name: 'Twin' });
    const inner = await tree.createTreeFolder(owner, 'files', { parentId: twin.id, name: 'Twin' });
    const c = await upload(inner.path, 'c.md');
    const t = await upload(twin.path, 't.md');
    await tree.deleteTreeFolder(owner, 'files', twin.id);
    const now = (await tree.loadTreeFolder(owner, 'files', { folderId: inner.id }))!;
    expect(now.folder).toMatchObject({ path: 'files.twin', depth: 1 });
    expect(now.items.map((i) => i.id)).toEqual([c.id]);
    expect((await tree.loadTreeFolder(owner, 'files'))!.items.map((i) => i.id)).toContain(t.id);
    expect((await stat(path.join(root, 'twin', 'c.md'))).isFile()).toBe(true);
    expect((await stat(path.join(root, 't.md'))).isFile()).toBe(true);
  });

  it('refuses a merge over an untracked file in a merging subfolder before anything moves', async () => {
    const dest = await tree.createTreeFolder(owner, 'files', { parentId: null, name: 'Dest' });
    const crate = await tree.createTreeFolder(owner, 'files', { parentId: null, name: 'Crate' });
    const inner = await tree.createTreeFolder(owner, 'files', { parentId: crate.id, name: 'Dest' });
    const f = await upload(crate.path, 'first.md');
    await writeFile(path.join(root, 'crate', 'dest', 'stray.bin'), 'x');
    await expect(tree.deleteTreeFolder(owner, 'files', crate.id)).rejects.toThrow(/stray\.bin/);
    const page = await tree.loadTreeFolder(owner, 'files', { folderId: crate.id });
    expect(page!.folders.map((x) => x.id)).toEqual([inner.id]);
    expect(page!.items.map((x) => x.id)).toEqual([f.id]);
    expect((await tree.loadTreeFolder(owner, 'files', { folderId: dest.id }))!.items).toEqual([]);
  });

  it('refuses a delete over an untracked file on disk before anything moves', async () => {
    const shell = await tree.createTreeFolder(owner, 'files', { parentId: null, name: 'Shell' });
    const sub = await tree.createTreeFolder(owner, 'files', { parentId: shell.id, name: 'Sub' });
    await upload(shell.path, 'tracked.md');
    await writeFile(path.join(root, 'shell', 'stray.bin'), 'x');
    await expect(tree.deleteTreeFolder(owner, 'files', shell.id)).rejects.toThrow(/stray\.bin/);
    // Nothing moved: the subfolder is still inside.
    const page = await tree.loadTreeFolder(owner, 'files', { folderId: shell.id });
    expect(page!.folders.map((f) => f.id)).toEqual([sub.id]);
  });

  it('keeps each login its own pins, recent and most used', async () => {
    const paged = (await tree.searchTree(owner, 'files', 'a.txt')).items[0]!;
    const other = (await tree.searchTree(owner, 'files', 'b.txt')).items[0]!;
    expect(await tree.recordItemOpened(owner, actor, paged.id)).toBe(true);
    expect(await tree.recordItemOpened(owner, actor, paged.id)).toBe(true);
    expect(await tree.recordItemOpened(owner, actor, other.id)).toBe(true);
    expect(await tree.recordItemOpened(owner, actor, randomUUID())).toBe(false);
    const used = await tree.listTreeMarks(owner, actor, 'files', 'used');
    expect(used.items.map((i) => i.id)).toEqual([paged.id, other.id]);
    const recent = await tree.listTreeMarks(owner, actor, 'files', 'recent');
    expect(recent.items[0]!.id).toBe(other.id);
    expect(await tree.setItemPinned(owner, actor, other.id, true)).toEqual({ ok: true });
    const pinned = await tree.listTreeMarks(owner, actor, 'files', 'pinned');
    expect(pinned.items.map((i) => i.id)).toEqual([other.id]);
    expect(pinned.items[0]!.crumbs.map((c) => c.name)).toEqual(['Paged']);
    await tree.setItemPinned(owner, actor, other.id, false);
    expect((await tree.listTreeMarks(owner, actor, 'files', 'pinned')).items).toEqual([]);
    expect((await tree.listTreeMarks(owner, randomUUID(), 'files', 'used')).items).toEqual([]);
  });
});
