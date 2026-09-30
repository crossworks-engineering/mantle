/**
 * Members' drafts ride along with the brain's folders (folder plan phase 5):
 * when an admin renames, moves or deletes a brain folder, the rows a member's
 * space holds under it (drafts and the member's own folders) follow in the
 * same transaction, merging with the member's existing folders by path and
 * clamped to three folder levels. Against a real, migrated Postgres and a
 * temporary files root:
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree-carry.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('members’ drafts follow the brain’s folders', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./index');
  let files: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  let root: string;
  let prevRoot: string | undefined;
  const brain = randomUUID();
  const member = randomUUID();
  const other = randomUUID();
  const tag = `carry-${brain.slice(0, 8)}`;
  let space = '';
  let otherSpace = '';

  /** A row owned by a member's space at `p` (a draft, or a folder). */
  const spaceRow = async (owner: string, type: 'note' | 'branch' | 'file', p: string) => {
    const id = randomUUID();
    const label = p.split('.').at(-1)!;
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, slug, path, data, tags)
      values (${id}, ${owner}, ${type}::node_type, ${`${tag} ${type} ${label}`},
              ${type === 'branch' ? label : null}, ${p}::ltree, '{}'::jsonb, '{}')`);
    return id;
  };
  const pathOf = async (id: string) => {
    const [row] = (await m.db.execute(
      sqlTag`select path::text as path from nodes where id = ${id}`,
    )) as unknown as { path: string }[];
    return row?.path ?? null;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-carry-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    tree = await import('./index');
    files = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${brain}, ${`${tag}-a@example.invalid`}, 'x', 'admin'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member'),
        (${other}, ${`${tag}-o@example.invalid`}, 'x', 'member')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})`);
    const rows = (await m.db.execute(sqlTag`
      select id, login_id from spaces where kind = 'personal'
         and login_id in (${member}, ${other})`)) as unknown as { id: string; login_id: string }[];
    space = rows.find((r) => r.login_id === member)!.id;
    otherSpace = rows.find((r) => r.login_id === other)!.id;
    await tree.ensureKindRoot(brain, 'notes');
    await files.ensureFilesRootBranch(brain);
  });

  afterAll(async () => {
    await m.db.execute(
      sqlTag`delete from nodes where owner_id in (${brain}, ${space}, ${otherSpace})`,
    );
    await m.db.execute(
      sqlTag`delete from spaces where id = ${brain} or login_id in (${member}, ${other})`,
    );
    await m.db.execute(sqlTag`delete from auth.users where id in (${brain}, ${member}, ${other})`);
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('a rename carries the drafts and folders of every member under the folder', async () => {
    const f = await tree.createTreeFolder(brain, 'notes', { parentId: null, name: 'Clients' });
    const draft = await spaceRow(space, 'note', 'notes.clients');
    const mine = await spaceRow(space, 'branch', 'notes.clients.mine');
    const deep = await spaceRow(space, 'note', 'notes.clients.mine');
    const theirs = await spaceRow(otherSpace, 'note', 'notes.clients');
    const elsewhere = await spaceRow(space, 'note', 'notes');
    await tree.updateTreeFolder(brain, 'notes', f.id, { name: 'Customers' });
    expect(await pathOf(draft)).toBe('notes.customers');
    expect(await pathOf(mine)).toBe('notes.customers.mine');
    expect(await pathOf(deep)).toBe('notes.customers.mine');
    expect(await pathOf(theirs)).toBe('notes.customers');
    expect(await pathOf(elsewhere)).toBe('notes');
  });

  it('a member folder whose new path the member already has merges into it', async () => {
    const f = await tree.createTreeFolder(brain, 'notes', { parentId: null, name: 'Old' });
    const oldTwin = await spaceRow(space, 'branch', 'notes.old');
    const newTwin = await spaceRow(space, 'branch', 'notes.new');
    const draft = await spaceRow(space, 'note', 'notes.old');
    await tree.updateTreeFolder(brain, 'notes', f.id, { name: 'New' });
    expect(await pathOf(oldTwin)).toBeNull();
    expect(await pathOf(newTwin)).toBe('notes.new');
    expect(await pathOf(draft)).toBe('notes.new');
  });

  it('a move carries them and clamps a member’s folders to three levels', async () => {
    const a = await tree.createTreeFolder(brain, 'notes', { parentId: null, name: 'Area' });
    const x = await tree.createTreeFolder(brain, 'notes', { parentId: null, name: 'Xs' });
    const y = await tree.createTreeFolder(brain, 'notes', { parentId: x.id, name: 'Ys' });
    const m1 = await spaceRow(space, 'branch', 'notes.area.m1');
    const m2 = await spaceRow(space, 'branch', 'notes.area.m1.m2');
    const inM2 = await spaceRow(space, 'note', 'notes.area.m1.m2');
    const inArea = await spaceRow(space, 'note', 'notes.area');
    // The brain's own subtree fits (Area has no subfolders); the member's
    // private folders never block the admin.
    await tree.updateTreeFolder(brain, 'notes', a.id, { parentId: y.id });
    expect(await pathOf(inArea)).toBe('notes.xs.ys.area');
    expect(await pathOf(m1)).toBeNull();
    expect(await pathOf(m2)).toBeNull();
    expect(await pathOf(inM2)).toBe('notes.xs.ys.area');
  });

  it('deleting a folder lifts the drafts to its parent and drops the member’s twin of it', async () => {
    const p = await tree.createTreeFolder(brain, 'notes', { parentId: null, name: 'Parent' });
    const gone = await tree.createTreeFolder(brain, 'notes', { parentId: p.id, name: 'Gone' });
    const twin = await spaceRow(space, 'branch', 'notes.parent.gone');
    const sub = await spaceRow(space, 'branch', 'notes.parent.gone.sub');
    const draft = await spaceRow(space, 'note', 'notes.parent.gone');
    const inSub = await spaceRow(space, 'note', 'notes.parent.gone.sub');
    await tree.deleteTreeFolder(brain, 'notes', gone.id);
    expect(await pathOf(gone.id)).toBeNull();
    expect(await pathOf(twin)).toBeNull();
    expect(await pathOf(draft)).toBe('notes.parent');
    expect(await pathOf(sub)).toBe('notes.parent.sub');
    expect(await pathOf(inSub)).toBe('notes.parent.sub');
  });

  it('a lift whose rows land on each other’s old paths goes through (audit C3)', async () => {
    // The member's own "Proj" inside the brain's "Proj", each holding "Y":
    // lifting maps notes.proj.proj.y onto notes.proj.y, which itself moves
    // on to notes.y. A one-pass rewrite hit the unique index by row order.
    const proj = await tree.createTreeFolder(brain, 'notes', { parentId: null, name: 'Proj' });
    // Inner rows first: a one-pass rewrite then meets them before the outer
    // "Y" has left notes.proj.y.
    const yInner = await spaceRow(space, 'branch', 'notes.proj.proj.y');
    const ownProj = await spaceRow(space, 'branch', 'notes.proj.proj');
    const yOuter = await spaceRow(space, 'branch', 'notes.proj.y');
    const inInner = await spaceRow(space, 'note', 'notes.proj.proj.y');
    await tree.deleteTreeFolder(brain, 'notes', proj.id);
    expect(await pathOf(proj.id)).toBeNull();
    expect(await pathOf(yOuter)).toBe('notes.y');
    expect(await pathOf(ownProj)).toBe('notes.proj');
    expect(await pathOf(yInner)).toBe('notes.proj.y');
    expect(await pathOf(inInner)).toBe('notes.proj.y');
    const [left] = (await m.db.execute(sqlTag`
      select count(*)::int as n from nodes where path <@ 'mantle_carry_tmp'`)) as unknown as {
      n: number;
    }[];
    expect(left!.n).toBe(0);
  });

  it('Files folders carry member files, mirrored under space_files (rename, move, delete)', async () => {
    const f = await tree.createTreeFolder(brain, 'files', { parentId: null, name: 'Docs' });
    const to = await tree.createTreeFolder(brain, 'files', { parentId: null, name: 'Archive' });
    const file = await spaceRow(space, 'file', 'space_files.docs');
    const folder = await spaceRow(space, 'branch', 'space_files.docs.drafts');
    const unsorted = await spaceRow(space, 'file', 'space_files');
    await tree.updateTreeFolder(brain, 'files', f.id, { name: 'Papers' });
    expect(await pathOf(file)).toBe('space_files.papers');
    expect(await pathOf(folder)).toBe('space_files.papers.drafts');
    await tree.updateTreeFolder(brain, 'files', f.id, { parentId: to.id });
    expect(await pathOf(file)).toBe('space_files.archive.papers');
    expect(await pathOf(folder)).toBe('space_files.archive.papers.drafts');
    await tree.deleteTreeFolder(brain, 'files', f.id);
    expect(await pathOf(file)).toBe('space_files.archive');
    expect(await pathOf(folder)).toBe('space_files.archive.drafts');
    expect(await pathOf(unsorted)).toBe('space_files');
  });

  it('a member reorganising its own space moves only its own rows', async () => {
    await m.db.execute(sqlTag`
      insert into nodes (owner_id, type, title, slug, path, data, tags)
      values (${space}, 'branch', 'Notes', 'notes', 'notes'::ltree, '{}'::jsonb, '{}')
      on conflict do nothing`);
    const own = await spaceRow(space, 'branch', 'notes.solo');
    const theirs = await spaceRow(otherSpace, 'note', 'notes.solo');
    await tree.updateTreeFolder(space, 'notes', own, { name: 'Alone' });
    expect(await pathOf(own)).toBe('notes.alone');
    expect(await pathOf(theirs)).toBe('notes.solo');
  });
});
