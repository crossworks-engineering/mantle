/**
 * The item tree on the kinds whose folders are rows only (phase 2), against a
 * real, migrated Postgres (docs/folder-tree.md):
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree-kinds.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the item tree on notes, tasks, events and secrets', () => {
  type Db = typeof import('@mantle/db');
  type Tree = typeof import('./index');
  let m: Db;
  let tree: Tree;
  let notes: typeof import('../notes');
  let tasks: typeof import('../tasks');
  let events: typeof import('../events');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `tree-kinds-${owner.slice(0, 8)}`;

  const pathOf = async (id: string) => {
    const [row] = (await m.db.execute(
      sqlTag`select path::text as path from nodes where id = ${id}`,
    )) as unknown as Array<{ path: string }>;
    return row?.path;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    tree = await import('./index');
    notes = await import('../notes');
    tasks = await import('../tasks');
    events = await import('../events');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    for (const kind of ['notes', 'tasks', 'events', 'secrets'] as const) {
      await tree.ensureKindRoot(owner, kind);
      await tree.ensureKindRoot(owner, kind); // idempotent
    }
  });

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
  });

  it('the Files folder operations refuse another kind’s folder (audit X1)', async () => {
    const files = await import('@mantle/files');
    const f = await tree.createTreeFolder(owner, 'notes', {
      parentId: null,
      name: 'Not files',
      icon: '🗂️',
      color: 'cyan',
    });
    // The look rides in the insert for a row-only kind.
    expect(f).toMatchObject({ icon: '🗂️', color: 'cyan' });
    const note = await notes.createNote(owner, { title: 'kept', content: 'x' });
    await tree.moveTreeItems(owner, 'notes', [note.id], f.id);
    // Its note is not a file, so the Files delete used to call it empty.
    expect(await files.deleteFolder({ ownerId: owner, folderId: f.id })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not a Files folder/),
    });
    await expect(
      files.moveFolderById({ ownerId: owner, folderId: f.id, destParentPath: 'files' }),
    ).rejects.toThrow(/not a Files folder/);
    await expect(
      files.renameFolderById({ ownerId: owner, folderId: f.id, newSlug: 'renamed' }),
    ).rejects.toThrow(/not a Files folder/);
    expect(await pathOf(note.id)).toBe(f.path);
    expect(await pathOf(f.id)).toBe(f.path);
  });

  it('files notes into folders, and renames and moves folders with what they hold', async () => {
    const clients = await tree.createTreeFolder(owner, 'notes', {
      parentId: null,
      name: 'Clients',
    });
    expect(clients.path).toBe('notes.clients');
    const acme = await tree.createTreeFolder(owner, 'notes', {
      parentId: clients.id,
      name: 'Acme Co',
    });
    expect(acme.path).toBe('notes.clients.acme_co');
    await expect(
      tree.createTreeFolder(owner, 'notes', { parentId: null, name: 'clients!' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const note = await notes.createNote(owner, { title: 'Kickoff', content: 'x' });
    expect(await tree.moveTreeItems(owner, 'notes', [note.id], acme.id)).toEqual({
      moved: 1,
      failed: [],
    });
    expect(await pathOf(note.id)).toBe('notes.clients.acme_co');

    // A new casing keeps the path; a new name moves the folder and its note.
    await tree.updateTreeFolder(owner, 'notes', acme.id, { name: 'ACME CO' });
    expect(await pathOf(acme.id)).toBe('notes.clients.acme_co');
    await tree.updateTreeFolder(owner, 'notes', acme.id, { name: 'Acme' });
    expect(await pathOf(note.id)).toBe('notes.clients.acme');

    const archive = await tree.createTreeFolder(owner, 'notes', {
      parentId: null,
      name: 'Archive',
    });
    await tree.updateTreeFolder(owner, 'notes', clients.id, { parentId: archive.id });
    expect(await pathOf(note.id)).toBe('notes.archive.clients.acme');

    // A third level exists now; nothing may go below it, nor move there.
    const deep = await tree.createTreeFolder(owner, 'notes', { parentId: null, name: 'Deep' });
    await expect(
      tree.createTreeFolder(owner, 'notes', {
        parentId: (await tree.treeFolderById(owner, 'notes', acme.id))!.id,
        name: 'Four',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      tree.updateTreeFolder(owner, 'notes', archive.id, { parentId: deep.id }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      tree.updateTreeFolder(owner, 'notes', archive.id, { parentId: acme.id }),
    ).rejects.toMatchObject({ code: 'invalid' });

    // Deleting lifts what it held; the note is not touched otherwise.
    await tree.deleteTreeFolder(owner, 'notes', acme.id);
    expect(await pathOf(note.id)).toBe('notes.archive.clients');
    const page = await tree.loadTreeFolder(owner, 'notes', { folderId: clients.id });
    expect(page!.items.map((i) => i.id)).toEqual([note.id]);
  });

  it('a delete merges clashing subfolders by path, recursively, and renames nothing', async () => {
    const keep = await tree.createTreeFolder(owner, 'notes', { parentId: null, name: 'Keep' });
    await tree.updateTreeFolder(owner, 'notes', keep.id, { icon: 'lucide:star' });
    const keepSub = await tree.createTreeFolder(owner, 'notes', { parentId: keep.id, name: 'Sub' });
    const there = await notes.createNote(owner, { title: 'Same title', content: 'x' });
    await tree.moveTreeItems(owner, 'notes', [there.id], keep.id);

    const drop = await tree.createTreeFolder(owner, 'notes', { parentId: null, name: 'Drop' });
    const dropKeep = await tree.createTreeFolder(owner, 'notes', {
      parentId: drop.id,
      name: 'Keep',
    });
    const dropSub = await tree.createTreeFolder(owner, 'notes', {
      parentId: dropKeep.id,
      name: 'Sub',
    });
    const fresh = await tree.createTreeFolder(owner, 'notes', {
      parentId: dropKeep.id,
      name: 'Fresh',
    });
    const same = await notes.createNote(owner, { title: 'Same title', content: 'y' });
    const deep = await notes.createNote(owner, { title: 'Deep', content: 'z' });
    const top = await notes.createNote(owner, { title: 'Top', content: 'w' });
    await tree.moveTreeItems(owner, 'notes', [same.id], dropKeep.id);
    await tree.moveTreeItems(owner, 'notes', [deep.id], dropSub.id);
    await tree.moveTreeItems(owner, 'notes', [top.id], drop.id);

    await tree.deleteTreeFolder(owner, 'notes', drop.id);

    expect(await pathOf(drop.id)).toBeUndefined();
    expect(await pathOf(dropKeep.id)).toBeUndefined();
    expect(await pathOf(dropSub.id)).toBeUndefined();
    expect(await pathOf(same.id)).toBe('notes.keep');
    expect(await pathOf(deep.id)).toBe('notes.keep.sub');
    expect(await pathOf(fresh.id)).toBe('notes.keep.fresh');
    expect(await pathOf(top.id)).toBe('notes');
    const page = (await tree.loadTreeFolder(owner, 'notes', { folderId: keep.id }))!;
    expect(page.folder).toMatchObject({ id: keep.id, name: 'Keep', icon: 'lucide:star' });
    expect(page.folders.map((f) => f.id).sort()).toEqual([fresh.id, keepSub.id].sort());
    // Two notes of one title in one folder: nothing is renamed.
    expect(
      page.items
        .filter((i) => i.title === 'Same title')
        .map((i) => i.id)
        .sort(),
    ).toEqual([same.id, there.id].sort());
  });

  it('a subfolder named like the deleted folder takes its place', async () => {
    const twin = await tree.createTreeFolder(owner, 'notes', { parentId: null, name: 'Twin' });
    const inner = await tree.createTreeFolder(owner, 'notes', { parentId: twin.id, name: 'Twin' });
    const innerSub = await tree.createTreeFolder(owner, 'notes', {
      parentId: inner.id,
      name: 'Twin',
    });
    const n = await notes.createNote(owner, { title: 'In twin twin', content: 'x' });
    await tree.moveTreeItems(owner, 'notes', [n.id], innerSub.id);
    await tree.deleteTreeFolder(owner, 'notes', twin.id);
    expect(await pathOf(inner.id)).toBe('notes.twin');
    expect(await pathOf(innerSub.id)).toBe('notes.twin.twin');
    expect(await pathOf(n.id)).toBe('notes.twin.twin');
  });

  it('moves older conversation digests into Notes / Auto-filed / Assistant once', async () => {
    const [digest] = (await m.db.execute(sqlTag`
      insert into nodes (owner_id, type, title, path, data, tags)
      values (${owner}, 'note', 'Topic · 2026-09-01', 'assistant', '{}'::jsonb,
              array['conversation-digest'])
      returning id`)) as unknown as Array<{ id: string }>;
    expect(await tree.reconcileNotesAutoFiled(owner)).toBe(1);
    expect(await pathOf(digest!.id)).toBe('notes.auto_filed.assistant');
    expect(await tree.reconcileNotesAutoFiled(owner)).toBe(0);
    const root = await tree.loadTreeFolder(owner, 'notes');
    const autoFiled = root!.folders.find((f) => f.path === 'notes.auto_filed');
    expect(autoFiled).toMatchObject({ name: 'Auto-filed', system: true, folderCount: 1 });
    // A system folder's name is locked.
    await expect(
      tree.updateTreeFolder(owner, 'notes', autoFiled!.id, { name: 'Mine' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    // Nor can it move or be deleted: the summarizer finds it by its path.
    const other = await tree.createTreeFolder(owner, 'notes', { parentId: null, name: 'Other' });
    await expect(
      tree.updateTreeFolder(owner, 'notes', autoFiled!.id, { parentId: other.id }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(tree.deleteTreeFolder(owner, 'notes', autoFiled!.id)).rejects.toMatchObject({
      code: 'invalid',
    });
    // The whole shape at once, each folder followed by its subfolders.
    const all = await tree.listTreeFolders(owner, 'notes');
    const at = all.findIndex((f) => f.path === 'notes.auto_filed');
    expect(all[at + 1]?.path).toBe('notes.auto_filed.assistant');
  });

  it('refuses to move an item of another kind', async () => {
    const box = await tree.createTreeFolder(owner, 'tasks', { parentId: null, name: 'Box' });
    const note = await notes.createNote(owner, { title: 'Not a task', content: '' });
    const res = await tree.moveTreeItems(owner, 'tasks', [note.id], box.id);
    expect(res.moved).toBe(0);
    expect(res.failed).toHaveLength(1);
  });

  it('orders tasks open-first by due date, carries the done box, and leaves archived tasks out', async () => {
    const soon = await tasks.createTask(owner, {
      title: 'Soon',
      dueAt: '2026-10-01T00:00:00.000Z',
    });
    const later = await tasks.createTask(owner, {
      title: 'Later',
      dueAt: '2026-12-01T00:00:00.000Z',
    });
    // Earlier as an instant, later as text: 2026-10-01T23:00+10:00 is
    // 13:00 UTC, before 2026-10-01T14:00Z (audit C5).
    const offsetEarly = await tasks.createTask(owner, {
      title: 'Offset early',
      dueAt: '2026-10-01T23:00:00+10:00',
    });
    const utcLater = await tasks.createTask(owner, {
      title: 'UTC later',
      dueAt: '2026-10-01T14:00:00.000Z',
    });
    const undated = await tasks.createTask(owner, { title: 'Undated' });
    const done = await tasks.createTask(owner, {
      title: 'Done',
      status: 'done',
      dueAt: '2026-01-01T00:00:00.000Z',
    });
    const gone = await tasks.createTask(owner, { title: 'Gone' });
    await tasks.updateTask(owner, gone.id, { archivedAt: new Date().toISOString() });

    const page = await tree.loadTreeFolder(owner, 'tasks', { sort: 'due' });
    expect(page!.items.map((i) => i.title)).toEqual([
      'Soon',
      'Offset early',
      'UTC later',
      'Later',
      'Undated',
      'Done',
    ]);
    await tasks.deleteTask(owner, offsetEarly.id);
    await tasks.deleteTask(owner, utcLater.id);
    const byId = new Map(page!.items.map((i) => [i.id, i]));
    expect(byId.get(soon.id)!.meta).toEqual({ done: false, due: '2026-10-01T00:00:00.000Z' });
    expect(byId.get(done.id)!.meta?.done).toBe(true);
    expect(byId.get(undated.id)!.meta?.due).toBeNull();
    expect(byId.has(later.id)).toBe(true);

    // Paging by cursor on the composite key neither skips nor repeats.
    const first = await tree.loadTreeFolder(owner, 'tasks', { sort: 'due', limit: 2 });
    const rest = await tree.loadTreeFolder(owner, 'tasks', {
      sort: 'due',
      limit: 2,
      cursor: first!.nextCursor,
    });
    expect([...first!.items, ...rest!.items].map((i) => i.title)).toEqual([
      'Soon',
      'Later',
      'Undated',
      'Done',
    ]);
    const all = await tree.searchTree(owner, 'tasks', '');
    expect(all.items.map((i) => i.title)).not.toContain('Gone');
  });

  it('orders events by start and shows it', async () => {
    await events.createEvent(owner, { title: 'Second', startsAt: '2026-11-02T09:00:00.000Z' });
    await events.createEvent(owner, { title: 'First', startsAt: '2026-11-01T09:00:00.000Z' });
    const page = await tree.loadTreeFolder(owner, 'events', { sort: 'start' });
    expect(page!.items.map((i) => i.title)).toEqual(['First', 'Second']);
    expect(page!.items[0]!.meta?.start).toMatch(/^2026-11-01/);
  });

  it('shows a secret’s kind in its status slot', async () => {
    const [row] = (await m.db.execute(sqlTag`
      insert into nodes (owner_id, type, title, path, data, tags)
      values (${owner}, 'secret', 'Router', 'secrets', '{"kind":"password"}'::jsonb, '{}')
      returning id`)) as unknown as Array<{ id: string }>;
    const page = await tree.loadTreeFolder(owner, 'secrets');
    expect(page!.items.find((i) => i.id === row!.id)?.subtype).toBe('password');
  });
});
