/**
 * Folder links show only what sits at the link's level (audit F19), against a
 * real, migrated Postgres. A file uploaded later into a publicly shared folder
 * lands at admin (no inheritance); the link must neither list nor serve it
 * until someone lowers it. The same goes for a subfolder above the level and
 * everything under it, and a subfolder's file count leaves hidden files out.
 * A client link shows client and public items. Single-item links are not
 * filtered. Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run shares-folder-levels.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Share } from '@mantle/db';
import { linkLevels } from './shares';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe('linkLevels', () => {
  it('a public link shows public, a client link client and public, anything else fails closed', () => {
    expect(linkLevels('public')).toEqual(['public']);
    expect(linkLevels('client')).toEqual(['client', 'public']);
    expect(linkLevels('team')).toEqual(['public']);
    expect(linkLevels('admin')).toEqual(['public']);
    expect(linkLevels('bogus')).toEqual(['public']);
  });
});

describe.skipIf(!URL)('folder links filter by level on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let shares: typeof import('./shares');
  let presenter: typeof import('@/components/share/folder-presenter');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `folder-levels-${owner.slice(0, 8)}`;
  // Unique ltree labels, so parallel runs never share a path.
  const root = `files.fl_${owner.slice(0, 8)}`;
  const cli = `files.fc_${owner.slice(0, 8)}`;
  const id = {
    root: randomUUID(),
    pub: randomUUID(),
    adm: randomUUID(),
    sub: randomUUID(), // admin subfolder
    subPub: randomUUID(), // public file under the admin subfolder
    open: randomUUID(), // public subfolder
    openPub: randomUUID(),
    openAdm: randomUUID(),
    cli: randomUUID(),
    cliCli: randomUUID(),
    cliPub: randomUUID(),
    cliAdm: randomUUID(),
  };

  const shareOf = (nodeId: string, nodeType: string) =>
    ({ id: randomUUID(), ownerId: owner, nodeId, nodeType, token: 't' }) as unknown as Share;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    shares = await import('./shares');
    presenter = await import('@/components/share/folder-presenter');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    const rows: Array<[string, string, string, string, string]> = [
      [id.root, 'branch', 'shared', root, 'public'],
      [id.pub, 'file', 'pub.txt', root, 'public'],
      [id.adm, 'file', 'later-upload.txt', root, 'admin'],
      [id.sub, 'branch', 'private', `${root}.private`, 'admin'],
      [id.subPub, 'file', 'deep.txt', `${root}.private`, 'public'],
      [id.open, 'branch', 'open', `${root}.open`, 'public'],
      [id.openPub, 'file', 'open-pub.txt', `${root}.open`, 'public'],
      [id.openAdm, 'file', 'open-adm.txt', `${root}.open`, 'admin'],
      [id.cli, 'branch', 'clients', cli, 'client'],
      [id.cliCli, 'file', 'for-clients.txt', cli, 'client'],
      [id.cliPub, 'file', 'for-all.txt', cli, 'public'],
      [id.cliAdm, 'file', 'internal.txt', cli, 'admin'],
    ];
    for (const [nid, type, title, path, audience] of rows) {
      const data =
        type === 'file' ? { filename: title, mime_type: 'text/plain', size_bytes: 1 } : {};
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path, audience, data)
        values (${nid}, ${owner}, ${type}, ${title}, ${path}::ltree, ${audience}, ${JSON.stringify(data)}::jsonb)`);
    }
  });

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  const listing = async (folderId: string, sub = '') => {
    const view = await shares.loadShareView(shareOf(folderId, 'branch'));
    if (view?.kind !== 'folder') throw new Error('not a folder view');
    const l = await presenter.loadFolderListing(owner, view, sub);
    return {
      levels: view.levels,
      currentPath: l.currentPath,
      folders: l.folders.map((f) => [f.slug, f.fileCount]),
      files: l.files.map((f) => f.filename),
    };
  };

  it('a public folder link lists only public items, and counts only them', async () => {
    const l = await listing(id.root);
    expect(l.levels).toEqual(['public']);
    expect(l.files).toEqual(['pub.txt']);
    // The admin subfolder is left out; the public one counts its public file only.
    expect(l.folders).toEqual([['open', 1]]);
    expect(await listing(id.root, 'open')).toMatchObject({
      currentPath: `${root}.open`,
      files: ['open-pub.txt'],
    });
  });

  it('a ?p= into a hidden folder falls back to the shared root', async () => {
    const l = await listing(id.root, 'private');
    expect(l.currentPath).toBe(root);
    expect(l.files).toEqual(['pub.txt']);
  });

  it('serves only the files the listing shows', async () => {
    const link = shareOf(id.root, 'branch');
    expect(await shares.isAssetAllowed(link, id.pub)).toBe(true);
    expect(await shares.isAssetAllowed(link, id.openPub)).toBe(true);
    // The later upload (admin), an admin file in a public subfolder, and a
    // public file under an admin subfolder: none reachable.
    expect(await shares.isAssetAllowed(link, id.adm)).toBe(false);
    expect(await shares.isAssetAllowed(link, id.openAdm)).toBe(false);
    expect(await shares.isAssetAllowed(link, id.subPub)).toBe(false);
    // Outside the folder, whatever its level.
    expect(await shares.isAssetAllowed(link, id.cliPub)).toBe(false);
  });

  it('a client folder link shows client and public items, not admin ones', async () => {
    const l = await listing(id.cli);
    expect(l.levels).toEqual(['client', 'public']);
    expect(l.files).toEqual(['for-all.txt', 'for-clients.txt']);
    const link = shareOf(id.cli, 'branch');
    expect(await shares.isAssetAllowed(link, id.cliCli)).toBe(true);
    expect(await shares.isAssetAllowed(link, id.cliPub)).toBe(true);
    expect(await shares.isAssetAllowed(link, id.cliAdm)).toBe(false);
  });

  it('a lowered file appears; a single-item link still serves its own file', async () => {
    await m.db.execute(sqlTag`update nodes set audience = 'public' where id = ${id.adm}`);
    try {
      expect((await listing(id.root)).files).toEqual(['later-upload.txt', 'pub.txt']);
      expect(await shares.isAssetAllowed(shareOf(id.root, 'branch'), id.adm)).toBe(true);
    } finally {
      await m.db.execute(sqlTag`update nodes set audience = 'admin' where id = ${id.adm}`);
    }
    // The item IS the link: a file link is not filtered by the file's level.
    expect(await shares.isAssetAllowed(shareOf(id.cliAdm, 'file'), id.cliAdm)).toBe(true);
  });
});
