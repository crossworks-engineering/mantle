/**
 * Auto-filed against a real, migrated Postgres and a temporary files root:
 * writers land in month and document folders, and an older brain's top-level
 * day folders move in once, merged by month, without losing a file.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/files/src/auto-filed.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('auto-filed', () => {
  type Db = typeof import('@mantle/db');
  type Files = typeof import('./index');
  let m: Db;
  let files: Files;
  let sqlTag: typeof import('drizzle-orm').sql;
  let root: string;
  let prevRoot: string | undefined;
  const owner = randomUUID();
  const tag = `autofiled-${owner.slice(0, 8)}`;

  const branch = async (p: string) =>
    (
      (await m.db.execute(sqlTag`
        select id, title, data from nodes
         where owner_id = ${owner} and type = 'branch' and path = ${p}::ltree`)) as unknown as Array<{
        id: string;
        title: string;
        data: Record<string, unknown>;
      }>
    )[0] ?? null;
  const filenamesIn = async (p: string) =>
    (
      (await m.db.execute(sqlTag`
        select data->>'filename' as f from nodes
         where owner_id = ${owner} and type = 'file' and path = ${p}::ltree
         order by 1`)) as unknown as Array<{ f: string }>
    ).map((r) => r.f);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-autofiled-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    files = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await files.ensureFilesRootBranch(owner);
  });

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('moves an older brain in once: day folders merge into months, nothing is lost', async () => {
    // The layout before Auto-filed: files/telegram-uploads/<day>/, and the
    // extracted images at the top.
    await files.createFolder({ ownerId: owner, parentPath: 'files', slug: 'telegram-uploads' });
    for (const day of ['2026-09-28', '2026-09-29', '2026-08-31']) {
      await files.createFolder({ ownerId: owner, parentPath: 'files.telegram_uploads', slug: day });
    }
    const up = (p: string, f: string) =>
      files.upsertFile({
        ownerId: owner,
        parentPath: p,
        filename: f,
        bytes: Buffer.from(`${p}/${f}`),
      });
    await up('files.telegram_uploads.2026_09_28', 'photo.jpg');
    await up('files.telegram_uploads.2026_09_29', 'photo.jpg');
    await up('files.telegram_uploads.2026_08_31', 'note.pdf');
    await files.createFolder({ ownerId: owner, parentPath: 'files', slug: 'extracted-images' });
    await files.createFolder({
      ownerId: owner,
      parentPath: 'files.extracted_images',
      slug: 'manual',
    });
    await up('files.extracted_images.manual', 'figure-1.png');

    const report = await files.reconcileAutoFiled(owner);
    expect(report.moved.sort()).toEqual(['extracted-images', 'telegram-uploads']);
    expect(report.mergedDays).toBe(3);

    const tg = 'files.auto_filed.telegram_uploads';
    expect(await filenamesIn(`${tg}.2026_09`)).toEqual(['photo-2.jpg', 'photo.jpg']);
    expect(await filenamesIn(`${tg}.2026_08`)).toEqual(['note.pdf']);
    expect(await branch('files.telegram_uploads')).toBeNull();
    expect(await branch(`${tg}.2026_09_28`)).toBeNull();
    expect(await filenamesIn('files.auto_filed.extracted_images.manual')).toEqual(['figure-1.png']);

    const top = await branch(tg);
    expect(top).toMatchObject({
      title: 'Telegram uploads',
      data: expect.objectContaining({ system: true }),
    });
    expect((await branch('files.auto_filed'))!.data.system).toBe(true);
    // The disk followed.
    expect(
      (await readdir(path.join(root, 'auto-filed', 'telegram-uploads', '2026-09'))).sort(),
    ).toEqual(['photo-2.jpg', 'photo.jpg']);

    expect(await files.reconcileAutoFiled(owner)).toEqual({ moved: [], mergedDays: 0 });
  });

  it('files new writes by month and by document', async () => {
    const month = files.autoFiledMonth();
    const p = await files.ensureAutoFiledFolder(owner, 'exports');
    expect(p).toBe(`files.auto_filed.exports.${month.replace('-', '_')}`);
    expect((await branch(p))!.data.system).toBe(true);
    const doc = await files.ensureExtractedImagesFolder({
      ownerId: owner,
      sourceSlug: 'owners-manual',
      sourceTitle: "Owner's manual",
    });
    expect(doc).toBe('files.auto_filed.extracted_images.owners_manual');
    expect(await files.ensureAutoFiledFolder(owner, 'api-docs')).toBe('files.auto_filed.api_docs');
  });

  it('locks a system folder: no rename, no move', async () => {
    const top = await branch('files.auto_filed.exports');
    await expect(
      files.renameFolderById({ ownerId: owner, folderId: top!.id, newSlug: 'Mine' }),
    ).rejects.toThrow(/made by Mantle/);
    await expect(
      files.moveFolderById({ ownerId: owner, folderId: top!.id, destParentPath: 'files' }),
    ).rejects.toThrow(/made by Mantle/);
  });
});
