/**
 * Area screenshots against a real, migrated Postgres and a temporary files
 * root, with no caller scope (the system's write): a screenshot is saved as
 * a plain upload to the top of Files (saveScreenshotFile), tagged, its
 * metadata on the file, with no login of its own (nodes.login_id null); a
 * taken name takes the next; the reads list the newest first and find one
 * by id, and a PNG that is no screenshot is not one. What a scope reads is
 * the database's row security (the workspace the file landed in, as for
 * any upload): logins in and out of that workspace, through the routes and
 * the MCP tool, in server/web/server/screenshots-members.db.test.ts.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/files/src/screenshots.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe.skipIf(!URL)('area screenshots', () => {
  type Db = typeof import('@mantle/db');
  type Files = typeof import('./index');
  let m: Db;
  let files: Files;
  let sqlTag: typeof import('drizzle-orm').sql;
  let root: string;
  let prevRoot: string | undefined;
  const owner = randomUUID();
  const tag = `shots-${owner.slice(0, 8)}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-screenshots-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    files = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await files.ensureFilesRootBranch(owner);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await asSuperuser()(sqlTag`delete from auth.users where id = ${owner}`);
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  const save = (at: Date, meta: Record<string, unknown>) =>
    files.saveScreenshotFile({
      ownerId: owner,
      filename: files.screenshotFilename(at),
      bytes: PNG,
      meta,
    });

  it('lands at the top of Files as a plain upload, tagged, its metadata on the file, no login', async () => {
    const at = new Date('2026-11-06T10:15:07Z');
    const saved = await save(at, { screen: 'Files', capturedAt: at.toISOString() });
    expect(saved.file.parentPath).toBe('files');
    expect(saved.file.filename).toBe('screenshot-2026-11-06-101507.png');
    expect(saved.file.mimeType).toBe('image/png');
    const [row] = (await m.db.execute(sqlTag`
      select tags, data, login_id::text as login from nodes where id = ${saved.file.id}`)) as unknown as Array<{
      tags: string[];
      data: Record<string, unknown>;
      login: string | null;
    }>;
    expect(row!.tags.sort()).toEqual(['file', 'screenshot']);
    expect(row!.data.screenshot).toEqual({ screen: 'Files', capturedAt: at.toISOString() });
    // Not private to a login: the workspace it lands in decides who reads it.
    expect(row!.login).toBeNull();
    expect(await readdir(root)).toContain('screenshot-2026-11-06-101507.png');
    // No Auto-filed folder of its own.
    const [shotsFolder] = (await m.db.execute(sqlTag`
      select 1 from nodes where owner_id = ${owner} and type = 'branch'
         and path <@ 'files.auto_filed'::ltree and title = 'Screenshots'`)) as unknown as unknown[];
    expect(shotsFolder).toBeUndefined();
  });

  it('the same second twice: the next free name, never over the first', async () => {
    const at = new Date('2026-11-06T10:15:07Z');
    const second = await save(at, { note: 'again' });
    expect(second.file.filename).toBe('screenshot-2026-11-06-101507-2.png');
    expect(second.file.parentPath).toBe('files');
  });

  it('lists the newest first and finds one by id; a plain PNG is no screenshot', async () => {
    const plain = await files.upsertFile({
      ownerId: owner,
      parentPath: 'files',
      filename: 'plain.png',
      bytes: PNG,
    });
    const list = await files.listScreenshots({ ownerId: owner, limit: 10 });
    expect(list.map((s) => s.filename)).toEqual([
      'screenshot-2026-11-06-101507-2.png',
      'screenshot-2026-11-06-101507.png',
    ]);
    expect(list[0]).toMatchObject({ note: 'again', sizeBytes: PNG.length, route: null });
    expect(await files.listScreenshots({ ownerId: owner, limit: 1 })).toHaveLength(1);

    const one = await files.screenshotById({ ownerId: owner, id: list[1]!.id });
    expect(one?.meta).toMatchObject({ screen: 'Files' });
    expect(await files.screenshotById({ ownerId: owner, id: plain.id })).toBeNull();
    expect(await files.screenshotById({ ownerId: owner, id: randomUUID() })).toBeNull();
  });
});
