/**
 * scan-pages-stamp on a real, migrated Postgres
 * (lib/maintenance/scan-pages-stamp.ts): a PDF whose database holds a
 * sketch read that left scan pages not read gets the read cut `scan_pages`
 * (read of total), its other cuts kept and its updated_at kept; a PDF read
 * whole, one with no sketch read, one with no database, one whose File tab
 * cannot be read and one that has the cut already are left. The dry run
 * counts and writes nothing; a second run stamps none. The File tabs are
 * stand-ins (the database files are not the point here). A scratch
 * database, dropped after (the stamp is box-wide).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/maintenance/scan-pages-stamp.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Tab = { visionRead: boolean; scanPagesRead: number; scanPagesNotRead: number } | null;
const h = vi.hoisted(() => ({ tabs: new Map<string, Tab>() }));

vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof import('@mantle/files')>()),
  fileDbSqlitePath: async (id: string) => (h.tabs.has(id) ? `/made-up/${id}` : null),
}));
vi.mock('@mantle/content/pdf-read', () => ({
  storedPdfOf: async (abs: string) => h.tabs.get(abs.split('/').pop()!) ?? null,
}));

describe.skipIf(!URL)('scan-pages-stamp', () => {
  let m: typeof import('@mantle/db');
  let stamp: typeof import('./scan-pages-stamp');
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  const SHA = 'a'.repeat(64);
  const id = {
    capped: randomUUID(), // read under the old 10-page cap: to stamp
    whole: randomUUID(), // every scan page read
    plain: randomUUID(), // a database with no sketch read
    noDb: randomUUID(), // no database
    busy: randomUUID(), // a File tab that cannot be read now
    done: randomUUID(), // has the cut already
    other: randomUUID(), // not a PDF
  };
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async (q: ReturnType<typeof sql>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const dataOf = async (nid: string) =>
    (
      await x<{ data: Record<string, unknown>; at: string }>(
        sql`select data, updated_at::text as at from nodes where id = ${nid}`,
      )
    )[0]!;

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    m = await import('@mantle/db');
    stamp = await import('./scan-pages-stamp');
    const admin = (m.systemDb as unknown as { $client: Parameters<typeof ensureTestAnchor>[0] })
      .$client;
    const anchor = await ensureTestAnchor(admin);
    const file = (nid: string, name: string, data: Record<string, unknown> = {}) =>
      su(sql`insert into nodes (id, owner_id, type, title, path, data, updated_at)
             values (${nid}, ${anchor}, 'file', ${name}, 'files',
                     ${JSON.stringify({ filename: name, sha256: SHA, ...data })}::jsonb,
                     '2026-01-02 03:04:05+00')`);
    await file(id.capped, 'iso-sheets.pdf', {
      read_cut: { pictures_small: { what: 'pictures', read: 1, total: 3 } },
    });
    await file(id.whole, 'whole.pdf');
    await file(id.plain, 'plain.pdf');
    await file(id.noDb, 'nodb.pdf');
    await file(id.busy, 'busy.pdf');
    await file(id.done, 'done.pdf', {
      read_cut: { scan_pages: { what: 'pages', read: 1, total: 2 } },
    });
    await file(id.other, 'sheet.xlsx');
    h.tabs = new Map<string, Tab>([
      [id.capped, { visionRead: true, scanPagesRead: 9, scanPagesNotRead: 131 }],
      [id.whole, { visionRead: true, scanPagesRead: 4, scanPagesNotRead: 0 }],
      [id.plain, { visionRead: false, scanPagesRead: 0, scanPagesNotRead: 0 }],
      [id.busy, null],
      [id.done, { visionRead: true, scanPagesRead: 1, scanPagesNotRead: 1 }],
      [id.other, { visionRead: true, scanPagesRead: 1, scanPagesNotRead: 5 }],
    ]);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('the dry run counts the file read in part and writes nothing', async () => {
    const before = await dataOf(id.capped);
    expect(await stamp.stampScanPages(false)).toEqual({
      pdfs: 5,
      sketched: 2,
      partial: 1,
      stamped: 0,
      unreadable: 1,
    });
    expect(await dataOf(id.capped)).toEqual(before);
  });

  it('apply stamps the cut, keeps the other cuts and updated_at; a second run stamps none', async () => {
    const before = await dataOf(id.capped);
    expect((await stamp.stampScanPages(true)).stamped).toBe(1);
    const after = await dataOf(id.capped);
    expect(after.data.read_cut).toEqual({
      pictures_small: { what: 'pictures', read: 1, total: 3 },
      scan_pages: { what: 'pages', read: 9, total: 140 },
    });
    expect(after.at).toBe(before.at);
    for (const nid of [id.whole, id.plain, id.noDb, id.busy, id.other]) {
      expect((await dataOf(nid)).data.read_cut, nid).toBeUndefined();
    }
    expect((await dataOf(id.done)).data.read_cut).toEqual({
      scan_pages: { what: 'pages', read: 1, total: 2 },
    });
    expect(await stamp.stampScanPages(true)).toMatchObject({ partial: 0, stamped: 0 });
  });

  it('the cut of a File tab', () => {
    expect(
      stamp.scanPagesCutOf({ visionRead: true, scanPagesRead: 3, scanPagesNotRead: 2 }),
    ).toEqual({ what: 'pages', read: 3, total: 5 });
    expect(
      stamp.scanPagesCutOf({ visionRead: true, scanPagesRead: 3, scanPagesNotRead: 0 }),
    ).toBeNull();
    expect(
      stamp.scanPagesCutOf({ visionRead: false, scanPagesRead: 0, scanPagesNotRead: 4 }),
    ).toBeNull();
  });
});
