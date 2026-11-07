/**
 * A copy or an export of a login's own file (nodes.login_id) is that
 * login's own too: copying never makes a private file readable by the
 * destination folder's workspaces (move-copy.ts copyFileById, the folder
 * copy through it; export-home.ts saveExport). Against a real, migrated
 * Postgres:
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/files/src/copy-keeps-login.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a copy keeps the source file login', () => {
  let m: typeof import('@mantle/db');
  let files: typeof import('./index');
  let sqlTag: typeof import('drizzle-orm').sql;
  let root: string;
  let prevRoot: string | undefined;
  const owner = randomUUID();
  const login = randomUUID();
  const tag = `copy-login-${owner.slice(0, 8)}`;
  const top = `files.${tag.replace(/-/g, '_')}`;
  const dest = `${top}.dest`;

  const loginOf = async (id: string) =>
    (
      (await m.db.execute(
        sqlTag`select login_id::text as l from nodes where id = ${id}`,
      )) as unknown as {
        l: string | null;
      }[]
    )[0]?.l ?? null;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-copy-login-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    files = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin'),
        (${login}, ${`${tag}-m@example.invalid`}, 'x', 'member')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (owner_id, type, title, slug, path) values
        (${owner}, 'branch', 'files', 'files', 'files'),
        (${owner}, 'branch', ${tag}, ${tag}, ${top}::ltree),
        (${owner}, 'branch', 'dest', 'dest', ${dest}::ltree)
      on conflict do nothing`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner} or id = ${login}`);
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it("a copy of a login's own file is that login's own; a copy of a shared file is shared", async () => {
    const own = await files.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: 'private.txt',
      bytes: Buffer.from('mine'),
      loginId: login,
    });
    expect(await loginOf(own.id)).toBe(login);
    const copy = await files.copyFileById({ ownerId: owner, fileId: own.id, destPath: dest });
    expect(await loginOf(copy.id)).toBe(login);
    const shared = await files.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: 'shared.txt',
      bytes: Buffer.from('ours'),
    });
    const sharedCopy = await files.copyFileById({
      ownerId: owner,
      fileId: shared.id,
      destPath: dest,
      newFilename: 'shared-copy.txt',
    });
    expect(await loginOf(sharedCopy.id)).toBeNull();
  });

  it("an export of a login's own item names that login; of another item, none", async () => {
    const own = await files.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: 'source.txt',
      bytes: Buffer.from('mine'),
      loginId: login,
    });
    expect(await files.exportOfLogin(owner, own.id)).toBe(login);
    expect(await files.exportOfLogin(owner, randomUUID())).toBeNull();
    expect(await files.exportOfLogin(owner, 'not-an-id')).toBeNull();
  });
});
