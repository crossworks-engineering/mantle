/**
 * The visibility confirm for Files writes outside the tree routes
 * (files-guard.ts), against a real, migrated Postgres and a temporary files
 * root: a file or folder moved or copied into a shared folder, and a new file
 * written there, is refused with the list until confirmed; out of a shared
 * folder too; an unshared destination passes.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/files-guard.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the Files visibility guards', () => {
  let m: typeof import('@mantle/db');
  let tree: typeof import('./index');
  let files: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  let root: string;
  let prevRoot: string | undefined;
  const owner = randomUUID();
  const tag = `fguard-${owner.slice(0, 8)}`;
  let portal = { id: '', path: '' };
  let plain = { id: '', path: '' };
  let fileId = '';
  let folderId = '';

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-fguard-'));
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
    const p = await tree.createTreeFolder(owner, 'files', { parentId: null, name: 'Portal' });
    await tree.updateTreeFolder(owner, 'files', p.id, { share: 'client' }, { confirm: true });
    const q = await tree.createTreeFolder(owner, 'files', { parentId: null, name: 'Plain' });
    const inner = await tree.createTreeFolder(owner, 'files', { parentId: q.id, name: 'Inner' });
    portal = { id: p.id, path: p.path };
    plain = { id: q.id, path: q.path };
    folderId = inner.id;
    const f = await files.upsertFile({
      ownerId: owner,
      parentPath: q.path,
      filename: 'payroll.txt',
      bytes: Buffer.from('x'),
    });
    fileId = f.id;
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a file moved or copied into a client-shared folder until confirmed', async () => {
    await expect(tree.guardFileTo(owner, fileId, portal.path, {})).rejects.toMatchObject({
      name: 'TreeVisibilityError',
      diff: { total: 1, changes: [{ id: fileId, from: 'admin', to: 'client' }] },
    });
    await expect(tree.guardFileTo(owner, fileId, portal.path, { confirm: true })).resolves.toEqual(
      expect.objectContaining({ total: 1 }),
    );
    await expect(tree.guardFileTo(owner, fileId, 'files', {})).resolves.toEqual({
      changes: [],
      total: 0,
    });
  });

  it('refuses a folder moved under a shared folder, with what it holds', async () => {
    await files.upsertFile({
      ownerId: owner,
      parentPath: `${plain.path}.inner`,
      filename: 'inside.txt',
      bytes: Buffer.from('y'),
    });
    // What it holds changes (the folder row itself is not listed).
    await expect(tree.guardFolderTo(owner, folderId, portal.path, {})).rejects.toMatchObject({
      diff: { total: 1, changes: [{ title: 'inside.txt', from: 'admin', to: 'client' }] },
    });
    await expect(tree.guardFolderTo(owner, folderId, 'files', {})).resolves.toMatchObject({
      total: 0,
    });
    // Not the owner's folder: passes, the operation refuses it.
    await expect(tree.guardFolderTo(owner, randomUUID(), portal.path, {})).resolves.toMatchObject({
      total: 0,
    });
  });

  it('refuses a new file in a shared folder, and out of one too', async () => {
    await expect(tree.guardNewFileIn(owner, portal.path, 'new.txt', {})).rejects.toMatchObject({
      diff: { total: 1, changes: [{ title: 'new.txt', from: 'admin', to: 'client' }] },
    });
    await expect(tree.guardNewFileIn(owner, plain.path, 'new.txt', {})).resolves.toMatchObject({
      total: 0,
    });
    const shared = await files.upsertFile({
      ownerId: owner,
      parentPath: portal.path,
      filename: 'shared.txt',
      bytes: Buffer.from('z'),
    });
    await expect(tree.guardFileTo(owner, shared.id, plain.path, {})).rejects.toMatchObject({
      diff: { changes: [{ id: shared.id, from: 'client', to: 'admin' }] },
    });
  });

  it('a copy takes the share where it lands, never the source’s (review F1)', async () => {
    // Internal is shared with the team; copying it into the client-shared
    // portal makes NEW unshared folders there, so its files would be read by
    // clients. A move keeps Internal's own share (no change); a copy does not.
    const internal = await tree.createTreeFolder(owner, 'files', {
      parentId: null,
      name: 'Internal',
    });
    await tree.updateTreeFolder(owner, 'files', internal.id, { share: 'team' }, { confirm: true });
    const memo = await files.upsertFile({
      ownerId: owner,
      parentPath: internal.path,
      filename: 'memo.txt',
      bytes: Buffer.from('m'),
    });
    await expect(tree.guardFolderCopyTo(owner, internal.id, portal.path, {})).rejects.toMatchObject(
      { diff: { total: 1, changes: [{ id: memo.id, from: 'team', to: 'client' }] } },
    );
    await expect(tree.guardFileCopyTo(owner, memo.id, portal.path, {})).rejects.toMatchObject({
      diff: { total: 1 },
    });
    // A copy that lands LESS open asks nothing.
    await expect(tree.guardFileCopyTo(owner, memo.id, plain.path, {})).resolves.toMatchObject({
      total: 0,
    });
  });
});
