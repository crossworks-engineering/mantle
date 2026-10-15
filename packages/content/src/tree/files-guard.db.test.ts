/**
 * The visibility confirm for Files writes outside the tree routes
 * (files-guard.ts), on a scratch brain the workspaces migration made live
 * and a temporary files root: a file or folder moved or copied into a
 * folder another workspace reads, and a new file written there, is refused
 * with the workspaces it would reach until confirmed; out of one too (what
 * it loses); a folder only Admin reads passes.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/files-guard.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the Files visibility guards', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tree: typeof import('./index');
  let files: typeof import('@mantle/files');
  let root: string;
  let prevRoot: string | undefined;
  const owner = randomUUID();
  const C = randomUUID();
  const T = randomUUID();
  let portal = { id: '', path: '' };
  let plain = { id: '', path: '' };
  let fileId = '';
  let folderId = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const grant = (id: string, ws: string) =>
    m.withSubtreeHeads(id, [], async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id)
                           values (${id}, ${ws})`);
    });
  const clients = [{ wsId: C, name: 'Clients' }];

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-fguard-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    tree = await import('./index');
    files = await import('@mantle/files');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role)
                values (${owner}, ${`fguard-${owner.slice(0, 8)}@example.invalid`}, 'x', true, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
                on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    await x(sql`insert into workspaces (id, owner_id, name) values
                (${C}, ${owner}, 'Clients'), (${T}, ${owner}, 'Internal team')`);
    await files.ensureFilesRootBranch(owner);
    const p = await tree.createTreeFolder(owner, 'files', { parentId: null, name: 'Portal' });
    await grant(p.id, C);
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
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a file moved or copied into a folder Clients reads until confirmed', async () => {
    await expect(tree.guardFileTo(owner, fileId, portal.path, {})).rejects.toMatchObject({
      name: 'TreeVisibilityError',
      diff: {
        total: 1,
        changes: [{ id: fileId, title: 'payroll.txt', alsoVisibleTo: clients, removedFrom: [] }],
      },
    });
    await expect(tree.guardFileTo(owner, fileId, portal.path, { confirm: true })).resolves.toEqual(
      expect.objectContaining({ total: 1 }),
    );
    // A confirm for another count asks again.
    await expect(
      tree.guardFileTo(owner, fileId, portal.path, { confirm: true, seen: 2 }),
    ).rejects.toMatchObject({ name: 'TreeVisibilityError' });
    await expect(tree.guardFileTo(owner, fileId, 'files', {})).resolves.toEqual({
      changes: [],
      total: 0,
    });
  });

  it('refuses a folder moved under a folder Clients reads, with what it holds', async () => {
    await files.upsertFile({
      ownerId: owner,
      parentPath: `${plain.path}.inner`,
      filename: 'inside.txt',
      bytes: Buffer.from('y'),
    });
    // The folder and what it holds.
    await expect(tree.guardFolderTo(owner, folderId, portal.path, {})).rejects.toMatchObject({
      diff: {
        total: 2,
        changes: [
          { title: 'Inner', alsoVisibleTo: clients },
          { title: 'inside.txt', alsoVisibleTo: clients },
        ],
      },
    });
    await expect(tree.guardFolderTo(owner, folderId, 'files', {})).resolves.toMatchObject({
      total: 0,
    });
    // Not the owner's folder: passes, the operation refuses it.
    await expect(tree.guardFolderTo(owner, randomUUID(), portal.path, {})).resolves.toMatchObject({
      total: 0,
    });
  });

  it('refuses a new file in a folder Clients reads, and a file leaving it', async () => {
    await expect(tree.guardNewFileIn(owner, portal.path, 'new.txt', {})).rejects.toMatchObject({
      diff: {
        total: 1,
        changes: [{ id: '', title: 'new.txt', alsoVisibleTo: clients, removedFrom: [] }],
      },
    });
    await expect(tree.guardNewFileIn(owner, plain.path, 'new.txt', {})).resolves.toMatchObject({
      total: 0,
    });
    await expect(tree.guardNewFileIn(owner, 'files', 'new.txt', {})).resolves.toMatchObject({
      total: 0,
    });
    const shared = await files.upsertFile({
      ownerId: owner,
      parentPath: portal.path,
      filename: 'shared.txt',
      bytes: Buffer.from('z'),
    });
    await expect(tree.guardFileTo(owner, shared.id, plain.path, {})).rejects.toMatchObject({
      diff: { changes: [{ id: shared.id, alsoVisibleTo: [], removedFrom: clients }] },
    });
  });

  it('a copy takes the grants where it lands, never the source’s (review F1)', async () => {
    // Internal is read by the internal team; copying it into the portal
    // makes NEW folders there, so its files would be read by Clients. A move
    // keeps Internal's own grants; a copy does not.
    const internal = await tree.createTreeFolder(owner, 'files', {
      parentId: null,
      name: 'Internal',
    });
    await grant(internal.id, T);
    const memo = await files.upsertFile({
      ownerId: owner,
      parentPath: internal.path,
      filename: 'memo.txt',
      bytes: Buffer.from('m'),
    });
    await expect(tree.guardFolderCopyTo(owner, internal.id, portal.path, {})).rejects.toMatchObject(
      {
        diff: {
          total: 1,
          changes: [{ id: memo.id, alsoVisibleTo: clients, removedFrom: [] }],
        },
      },
    );
    await expect(tree.guardFileCopyTo(owner, memo.id, portal.path, {})).rejects.toMatchObject({
      diff: { total: 1 },
    });
    // A copy read by fewer asks nothing.
    await expect(tree.guardFileCopyTo(owner, memo.id, plain.path, {})).resolves.toMatchObject({
      total: 0,
    });
  });
});
