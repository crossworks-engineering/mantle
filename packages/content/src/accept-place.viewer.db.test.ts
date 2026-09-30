/**
 * Accept claims in place (folder plan phase 5), on a real, migrated Postgres
 * and temporary disk roots: a member's draft filed in a brain folder lands
 * there on Accept, the member's own folders below it become brain folders
 * (merging by name, keeping their name and look, cut to three levels), the
 * admin may pick another folder (the member's folders still go below it),
 * and the member's emptied folders go. Files land on the brain's disk path.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/accept-place.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('Accept claims in place', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sp: typeof import('./member-space');
  let sf: typeof import('./member-space-files');
  let rv: typeof import('./member-review');
  let tree: typeof import('./tree/index');
  let fp: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `aplace-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const login = randomUUID();
  let space = '';
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-aplace-'));
  const reviewer = () => ({ loginId: anchor, name: 'Reviewer' });
  const folders: Record<string, string> = {};

  const as = <T>(fn: () => Promise<T>) => m.withSpace({ spaceId: space, loginId: login }, fn);
  const row = async (id: string) =>
    (
      (await m.systemDb.execute(sqlTag`
        select owner_id, path::text as path, title, data from nodes where id = ${id}`)) as unknown as Array<{
        owner_id: string;
        path: string;
        title: string;
        data: Record<string, unknown> | null;
      }>
    )[0] ?? null;
  const brainFolderAt = async (p: string) =>
    (
      (await m.systemDb.execute(sqlTag`
        select id, title, data from nodes
         where owner_id = ${anchor} and type = 'branch' and path = ${p}::ltree`)) as unknown as Array<{
        id: string;
        title: string;
        data: Record<string, unknown> | null;
      }>
    )[0] ?? null;
  const ownFolder = async (p: string, title: string, data: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, slug, path, audience, data, tags)
      values (${id}, ${space}, 'branch', ${title}, ${p.split('.').at(-1)!}, ${p}::ltree, 'admin',
              ${JSON.stringify(data)}::jsonb, '{}')`);
    return id;
  };
  const submittedNote = async (title: string, at: string) => {
    const note = await as(() =>
      sp.createMineItem(space, { type: 'note', title, content: 'x' }, {}, { path: at }),
    );
    await as(() => sp.submitItem(space, note.id));
    return note.id;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.MANTLE_SPACES_ROOT = path.join(root, 'spaces');
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    sp = await import('./member-space');
    sf = await import('./member-space-files');
    rv = await import('./member-review');
    tree = await import('./tree/index');
    fp = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${anchor}, ${`${tag}-admin@example.invalid`}, 'x', 'admin'),
        (${login}, ${`${tag}-m@example.invalid`}, 'x', 'member')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`);
    const [s] = (await m.systemDb.execute(sqlTag`
      select id from spaces where kind = 'personal' and login_id = ${login}`)) as unknown as {
      id: string;
    }[];
    space = s!.id;
    await tree.ensureKindRoot(anchor, 'notes');
    await fp.ensureFilesRootBranch(anchor);
    const clients = await tree.createTreeFolder(anchor, 'notes', {
      parentId: null,
      name: 'Clients',
    });
    const acme = await tree.createTreeFolder(anchor, 'notes', {
      parentId: clients.id,
      name: 'Acme',
    });
    const deep = await tree.createTreeFolder(anchor, 'notes', { parentId: acme.id, name: 'Deep' });
    const docs = await tree.createTreeFolder(anchor, 'files', { parentId: null, name: 'Docs' });
    Object.assign(folders, { clients: clients.id, acme: acme.id, deep: deep.id, docs: docs.id });
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where owner_id in (${anchor}, ${space})`);
    await m.systemDb.execute(sqlTag`delete from spaces where id in (${anchor}, ${space})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${anchor}, ${login})`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps a draft in place and makes the member’s own folder a brain folder, name and look', async () => {
    const mine = await ownFolder('notes.clients.acme.mine', 'Mine Stuff', { icon: '📁' });
    const id = await submittedNote('in place', 'notes.clients.acme.mine');
    const preview = await rv.previewAccept(id, anchor);
    expect(preview?.place).toEqual({
      kind: 'notes',
      folderId: folders.acme,
      crumbs: [
        { id: folders.clients, name: 'Clients' },
        { id: folders.acme, name: 'Acme' },
      ],
      creates: ['Mine Stuff'],
    });
    await rv.acceptReviewItem(anchor, id, reviewer());
    expect(await row(id)).toMatchObject({ owner_id: anchor, path: 'notes.clients.acme.mine' });
    expect(await brainFolderAt('notes.clients.acme.mine')).toMatchObject({
      title: 'Mine Stuff',
      data: { icon: '📁' },
    });
    // The member's own folder held only that draft: it goes.
    expect(await row(mine)).toBeNull();
  });

  it('merges into a brain folder already there, and keeps a member folder still holding drafts', async () => {
    const twin = await ownFolder('notes.clients.acme.mine', 'Mine');
    const first = await submittedNote('merge one', 'notes.clients.acme.mine');
    const stays = await as(() =>
      sp.createMineItem(
        space,
        { type: 'note', title: 'stays', content: 'x' },
        {},
        {
          path: 'notes.clients.acme.mine',
        },
      ),
    );
    await rv.acceptReviewItem(anchor, first, reviewer());
    expect(await row(first)).toMatchObject({ path: 'notes.clients.acme.mine' });
    // The brain folder made above keeps its name; the member's still holds
    // a draft, so it stays.
    expect(await brainFolderAt('notes.clients.acme.mine')).toMatchObject({ title: 'Mine Stuff' });
    expect(await row(twin)).not.toBeNull();
    expect(await row(stays.id)).toMatchObject({ owner_id: space });
  });

  it('lands where the admin picks, the member’s folders below the pick', async () => {
    await ownFolder('notes.clients.acme.picked', 'Picked');
    const id = await submittedNote('picked', 'notes.clients.acme.picked');
    await rv.acceptReviewItem(anchor, id, reviewer(), { folderId: folders.clients });
    expect(await row(id)).toMatchObject({ path: 'notes.clients.picked' });
    expect(await brainFolderAt('notes.clients.picked')).toMatchObject({ title: 'Picked' });
  });

  it('cuts the member’s folders to fit three levels, and null is the top level', async () => {
    await ownFolder('notes.clients.acme.cut', 'Cut');
    const id = await submittedNote('cut', 'notes.clients.acme.cut');
    await rv.acceptReviewItem(anchor, id, reviewer(), { folderId: folders.deep });
    expect(await row(id)).toMatchObject({ path: 'notes.clients.acme.deep' });
    expect(await brainFolderAt('notes.clients.acme.deep.cut')).toBeNull();

    const top = await submittedNote('top', 'notes.clients.acme');
    await rv.acceptReviewItem(anchor, top, reviewer(), { folderId: null });
    expect(await row(top)).toMatchObject({ path: 'notes' });
  });

  it('refuses a folder of another kind, or not the brain’s', async () => {
    const id = await submittedNote('refused', 'notes.clients');
    await expect(
      rv.acceptReviewItem(anchor, id, reviewer(), { folderId: folders.docs }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    await expect(
      rv.acceptReviewItem(anchor, id, reviewer(), { folderId: randomUUID() }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(await row(id)).toMatchObject({ owner_id: space });
  });

  it('files an accepted file on the brain’s disk path of its folder', async () => {
    const spooled = await fp.spoolUpload(Readable.from([Buffer.from('DOCBYTES')]), {
      maxBytes: sf.SPACE_FILE_MAX_BYTES,
      dir: fp.spaceSpoolDir(),
    });
    const id = await as(() =>
      sf.createMineFile(space, { filename: 'Brief.txt', spooled, path: 'space_files.docs' }),
    );
    await as(() => sp.submitItem(space, id));
    expect((await rv.previewAccept(id, anchor))?.place).toMatchObject({
      kind: 'files',
      folderId: folders.docs,
      creates: [],
    });
    await rv.acceptReviewItem(anchor, id, reviewer());
    const accepted = await row(id);
    expect(accepted).toMatchObject({ owner_id: anchor, path: 'files.docs' });
    // The name as the brain filed it (Accept's own sanitised name), exactly:
    // a case-sensitive disk must find it.
    const onDisk = path.join(root, 'files', 'docs', String(accepted!.data?.filename));
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk, 'utf8')).toBe('DOCBYTES');
  });

  it('a client from before the tree still files every file in its folderPath', async () => {
    const spooled = await fp.spoolUpload(Readable.from([Buffer.from('OLD')]), {
      maxBytes: sf.SPACE_FILE_MAX_BYTES,
      dir: fp.spaceSpoolDir(),
    });
    const id = await as(() =>
      sf.createMineFile(space, { filename: 'Old.txt', spooled, path: 'space_files.docs' }),
    );
    await as(() => sp.submitItem(space, id));
    await rv.acceptReviewItem(anchor, id, reviewer(), { folderPath: 'files' });
    expect(await row(id)).toMatchObject({ path: 'files' });
  });
});
