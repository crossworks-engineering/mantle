/**
 * A book's page pictures, saved by its Agent (G1, images.ts
 * bookPagePicturesFor), on a real migrated Postgres and a real files root:
 *
 *  - a page picture is a part of the book, private to its login, with its
 *    page, its bytes' sha256 and the text the Agent read as its description;
 *  - it is a page done (never drawn or asked again) only with its text;
 *  - a save again of the same page writes over it in place;
 *  - the count (`data.images.pages`) comes from what is saved and what is
 *    marked: a marked page with no picture shows the book `partial`, and the
 *    core's own part (`embedded`) is left as it is;
 *  - a picture of older bytes keeps its own text, and a page picture of new
 *    bytes goes to a folder of their own.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract/images-book-pages.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const PNG = (n: number, v = '') =>
  Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(`page ${n}${v}`)]);

describe.skipIf(!URL)("a book's page pictures, saved by its Agent", () => {
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let images: typeof import('./images');
  let sqlTag: typeof import('drizzle-orm').sql;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const FOLDER = 'files.bp1';
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-book-pages-'));

  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sqlTag>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const extract = <T>(fn: () => Promise<T>) => m.runAsSystem('queue:extract', fn) as Promise<T>;
  const dataOf = async (id: string) =>
    (
      await x<{ data: Record<string, unknown> }>(sqlTag`select data from nodes where id = ${id}`)
    )[0]!.data;
  const picturesOf = async (book: string) =>
    x<{ id: string; path: string; login_id: string | null; data: Record<string, unknown> }>(
      sqlTag`select id, path::text as path, login_id, data from nodes
              where type = 'file' and data->>'sourceFileId' = ${book} order by data->>'bookPage'`,
    );

  /** A book uploaded to the team folder, with a database whose reader
   *  marked `marked` for vision. */
  const book = async (marked: number[]) => {
    const bytes = Buffer.from(`made-up book ${randomUUID()}`);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const row = await m.withCreateHome({ createWs: team, privateWs: null }, () =>
      f.upsertFile({
        ownerId: anchor,
        parentPath: FOLDER,
        filename: `book-${sha.slice(0, 6)}.pdf`,
        bytes,
        overwrite: true,
      }),
    );
    await marks(row.id, sha, marked);
    return { id: row.id, sha };
  };
  const marks = async (id: string, sha: string, marked: number[]) => {
    const { writeFileDatabaseDoc } = await import('@mantle/content/table-broker');
    const { tabsOfSheets } = await import('@mantle/content/file-database');
    const { ensureWorkbookDoc } = await import('@mantle/content-core/table-model');
    const reader = f.BUILTIN_PIPELINES.find((p) => p.id === 'pdf-pages')!;
    const sqlite = f.fileDbPaths(id, sha)!.sqlite;
    mkdirSync(path.dirname(sqlite), { recursive: true });
    writeFileDatabaseDoc(
      sqlite,
      ensureWorkbookDoc({
        tabs: tabsOfSheets([
          {
            name: 'Pages',
            columns: [
              { name: 'Page', type: 'number' },
              { name: 'Method', type: 'text' },
            ],
            rows: [1, 2, 3, 4, 5].map((n) => [n, marked.includes(n) ? 'vision' : 'ocr']),
          },
        ]),
      }),
      { fileId: id, ownerId: anchor, stamp: f.pipelineStampOf(reader as never, []) },
    );
  };

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(root, 'tables');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    images = await import('./images');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<typeof m.ensureViewerRoles>[0] })
      .$client;
    anchor = await ensureTestAnchor(admin);
    await su(sqlTag`insert into workspaces (id, owner_id, name)
      values (${team}, ${anchor}, ${`team ${team.slice(0, 8)}`})`);
    await su(sqlTag`insert into workspaces (owner_id, name, is_admin)
      select ${anchor}::uuid, 'Admin', true where mantle_ws_admin_id(${anchor}::uuid) is null`);
    await x(sqlTag`insert into nodes (owner_id, type, title, slug, path)
      values (${anchor}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    await m.withCreateHome({ createWs: team, privateWs: null }, () =>
      m.withNodeInsertHeads(anchor, [{ type: 'branch', path: FOLDER }], (tx) =>
        tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
          values (${randomUUID()}, ${anchor}, 'branch', ${FOLDER}, ${FOLDER}::ltree)`),
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it('saves each page picture with its text, done only with it; a save again writes over it', async () => {
    const b = await book([2, 4]);
    const pics = images.bookPagePicturesFor(anchor, b.id, b.sha);
    const saved = await extract(() =>
      pics.save([
        { page: 2, bytes: PNG(2), mime: 'image/png', text: 'the text of page 2' },
        { page: 4, bytes: PNG(4), mime: 'image/png', text: 'the text of page 4' },
      ]),
    );
    expect(saved).toBe(2);
    const rows = await picturesOf(b.id);
    expect(rows.map((r) => [r.data.bookPage, r.data.text, r.data.sourceSha256])).toEqual([
      [2, 'the text of page 2', b.sha],
      [4, 'the text of page 4', b.sha],
    ]);
    // Both in one folder, the book's pictures folder.
    expect(new Set(rows.map((r) => r.path)).size).toBe(1);
    expect([...(await extract(() => pics.done()))].sort()).toEqual([2, 4]);
    // A save again of page 2 (its picture lost its row): the same node.
    expect(
      await extract(() =>
        pics.save([{ page: 2, bytes: PNG(2), mime: 'image/png', text: 'the text of page 2' }]),
      ),
    ).toBe(1);
    expect((await picturesOf(b.id)).map((r) => r.id)).toEqual(rows.map((r) => r.id));
    // A picture whose text was taken off is not done.
    await x(sqlTag`update nodes set data = data - 'text' where id = ${rows[1]!.id}`);
    expect([...(await extract(() => pics.done()))]).toEqual([2]);
  });

  it('the count is of what is saved and marked; the core part stands; all saved clears it', async () => {
    const b = await book([1, 3, 5]);
    await x(
      sqlTag`update nodes set data = data || ${JSON.stringify({
        images: { kept: 2, found: 3 },
      })}::jsonb where id = ${b.id}`,
    );
    expect(await extract(() => images.stampBookPagePictures(anchor, b.id, b.sha))).toEqual({
      kept: 0,
      found: 3,
    });
    let data = await dataOf(b.id);
    expect(data.images).toEqual({
      embedded: { kept: 2, found: 3 },
      pages: { kept: 0, found: 3 },
      kept: 2,
      found: 6,
    });
    expect(f.extractionOf({ ...data, extract_completed_at: 'x' }).hint).toMatch(
      /2 of 3 pictures kept\..*0 of 3 pages left to vision are read/,
    );
    const pics = images.bookPagePicturesFor(anchor, b.id, b.sha);
    await extract(() =>
      pics.save(
        [1, 3, 5].map((n) => ({ page: n, bytes: PNG(n), mime: 'image/png', text: `t${n}` })),
      ),
    );
    await extract(() => pics.count());
    data = await dataOf(b.id);
    expect(data.images).toEqual({ embedded: { kept: 2, found: 3 }, kept: 2, found: 3 });
  });

  it('new bytes: a picture of the older ones keeps its text, the new one goes to a folder of its own', async () => {
    const b = await book([2]);
    await extract(() =>
      images
        .bookPagePicturesFor(anchor, b.id, b.sha)
        .save([{ page: 2, bytes: PNG(2), mime: 'image/png', text: 'v1 text' }]),
    );
    // The book's bytes are replaced: the same page, read again.
    const sha2 = 'c'.repeat(64);
    await x(sqlTag`update nodes set data = data || ${JSON.stringify({ sha256: sha2 })}::jsonb
      where id = ${b.id}`);
    await marks(b.id, sha2, [2]);
    const v2 = images.bookPagePicturesFor(anchor, b.id, sha2);
    expect([...(await extract(() => v2.done()))]).toEqual([]);
    await extract(() =>
      v2.save([{ page: 2, bytes: PNG(2, ' v2'), mime: 'image/png', text: 'v2 text' }]),
    );
    const rows = await picturesOf(b.id);
    expect(rows.map((r) => [r.data.sourceSha256, r.data.text])).toEqual(
      expect.arrayContaining([
        [b.sha, 'v1 text'],
        [sha2, 'v2 text'],
      ]),
    );
    const [p1, p2] = [
      rows.find((r) => r.data.sourceSha256 === b.sha)!,
      rows.find((r) => r.data.sourceSha256 === sha2)!,
    ];
    expect(p1.path).not.toBe(p2.path);
    // A save for bytes the book no longer holds saves nothing.
    expect(
      await extract(() =>
        images
          .bookPagePicturesFor(anchor, b.id, b.sha)
          .save([{ page: 2, bytes: PNG(2), mime: 'image/png', text: 'late' }]),
      ),
    ).toBe(0);
  });
});
