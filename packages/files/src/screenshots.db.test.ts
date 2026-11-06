/**
 * Area screenshots against a real, migrated Postgres and a temporary files
 * root, with no caller scope (the system's write, as an Admin-scope caller
 * files): a screenshot saved by the export rule lands in Auto-filed /
 * Screenshots / <month>, tagged, its metadata on the file; a taken name
 * takes the next; the reads list the newest first and find one by id, and
 * a PNG that is no screenshot is not one. What a member's scope reads is
 * the database's row security (the scope the MCP gate enters); here the
 * reads run unscoped. Two members, each in its own scope, through the
 * routes and the MCP tool: server/web/server/screenshots-members.db.test.ts.
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
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  const save = (at: Date, meta: Record<string, unknown>) =>
    files.saveExport({
      ownerId: owner,
      filename: files.screenshotFilename(at),
      bytes: PNG,
      source: 'screenshots',
      tags: [files.SCREENSHOT_TAG],
      data: { screenshot: meta },
    });

  it('lands in Auto-filed / Screenshots / <month>, tagged, its metadata on the file', async () => {
    const at = new Date('2026-11-06T10:15:07Z');
    const saved = await save(at, { screen: 'Files', capturedAt: at.toISOString() });
    const month = files.autoFiledMonth().replace('-', '_');
    expect(saved.autoFiled).toBe(true);
    expect(saved.file.parentPath).toBe(`files.auto_filed.screenshots.${month}`);
    expect(saved.file.filename).toBe('screenshot-2026-11-06-101507.png');
    expect(saved.file.mimeType).toBe('image/png');
    const [row] = (await m.db.execute(sqlTag`
      select tags, data from nodes where id = ${saved.file.id}`)) as unknown as Array<{
      tags: string[];
      data: Record<string, unknown>;
    }>;
    expect(row!.tags.sort()).toEqual(['file', 'screenshot']);
    expect(row!.data.screenshot).toEqual({ screen: 'Files', capturedAt: at.toISOString() });
    const [top] = (await m.db.execute(sqlTag`
      select title, data from nodes
       where owner_id = ${owner} and type = 'branch'
         and path = 'files.auto_filed.screenshots'::ltree`)) as unknown as Array<{
      title: string;
      data: Record<string, unknown>;
    }>;
    expect(top).toMatchObject({
      title: 'Screenshots',
      data: expect.objectContaining({ system: true }),
    });
    expect(
      await readdir(path.join(root, 'auto-filed', 'screenshots', files.autoFiledMonth())),
    ).toContain('screenshot-2026-11-06-101507.png');
  });

  it('the same second twice: the next free name, never over the first', async () => {
    const at = new Date('2026-11-06T10:15:07Z');
    const second = await save(at, { note: 'again' });
    expect(second.file.filename).toBe('screenshot-2026-11-06-101507-2.png');
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
