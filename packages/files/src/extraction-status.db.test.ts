/**
 * A file the parser refused shows as failed (task 8d40932a), on a real,
 * migrated Postgres. The case from a client box: a 347 MB scanned PDF, past
 * the parser's PDF limit, got `extract_skipped: document_unreadable`, while
 * `indexing_applied` still said 'full' and nothing on any screen said its
 * content was missing. Now its file row says `failed` with the reason, the
 * `extraction` list finds it, also after a rename. A scan the OCR read 10
 * pages of is `partial`, as is a file whose reader said a cut (`read_cut`:
 * docs/files.md, "Read in part") or that kept fewer pictures than it
 * found; the stale list's `partial` (the exact SQL form) finds the same
 * files. Seeds its own owner and rows
 * and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/files/src/extraction-status.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)('a file the brain could not read says so', () => {
  type Db = typeof import('@mantle/db');
  type Ops = typeof import('./ops');
  let m: Db;
  let ops: Ops;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const tag = `xstat-${owner.slice(0, 8)}`;
  const folder = `files.${tag.replace(/-/g, '_')}`;
  const ids = {
    refused: randomUUID(),
    partial: randomUUID(),
    read: randomUUID(),
    sheet: randomUUID(),
    pictures: randomUUID(),
    noCut: randomUUID(),
    icons: randomUUID(),
    metafile: randomUUID(),
  };
  // A verdict stamped after the row's write, as the extractor stamps it.
  const later = new Date(Date.now() + 60_000).toISOString();

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    m = await import('@mantle/db');
    ops = await import('./ops');
    sqlTag = (await import('drizzle-orm')).sql;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, data) values
        (${ids.refused}, ${owner}, 'file', 'spec-book-1.pdf', ${folder},
          ${JSON.stringify({
            filename: 'spec-book-1.pdf',
            sha256: 'a',
            indexing_applied: 'full',
            parser_failures: { 'text:a': { n: 2, code: 'too_large' } },
            extract_skipped: { reason: 'document_unreadable', at: later },
          })}::jsonb),
        (${ids.partial}, ${owner}, 'file', 'spec-book-2.pdf', ${folder},
          ${JSON.stringify({
            filename: 'spec-book-2.pdf',
            sha256: 'b',
            indexing_applied: 'full',
            ocr: { pages_read: 10, pages_total: 679 },
            extract_completed_at: later,
          })}::jsonb),
        (${ids.read}, ${owner}, 'file', 'notes.txt', ${folder},
          ${JSON.stringify({
            filename: 'notes.txt',
            sha256: 'c',
            indexing_applied: 'full',
            extract_completed_at: later,
          })}::jsonb),
        (${ids.sheet}, ${owner}, 'file', 'ledger.xlsx', ${folder},
          ${JSON.stringify({
            filename: 'ledger.xlsx',
            sha256: 'd',
            indexing_applied: 'full',
            extract_completed_at: later,
            read_cut: { sheet_rows: { what: 'rows', read: 5000, total: 12000, limit: 5000 } },
          })}::jsonb),
        (${ids.pictures}, ${owner}, 'file', 'manual.docx', ${folder},
          ${JSON.stringify({
            filename: 'manual.docx',
            sha256: 'e',
            indexing_applied: 'full',
            extract_completed_at: later,
            images: { kept: 3, found: 5 },
          })}::jsonb),
        (${ids.noCut}, ${owner}, 'file', 'whole.xlsx', ${folder},
          ${JSON.stringify({
            filename: 'whole.xlsx',
            sha256: 'f',
            indexing_applied: 'full',
            extract_completed_at: later,
            read_cut: {},
            images: { kept: 2, found: 2 },
          })}::jsonb),
        (${ids.icons}, ${owner}, 'file', 'letter.docx', ${folder},
          ${JSON.stringify({
            filename: 'letter.docx',
            sha256: 'g',
            indexing_applied: 'full',
            extract_completed_at: later,
            read_cut: {
              pictures_small: { what: 'pictures', read: 1, total: 4 },
              pictures_tiny: { what: 'pictures', read: 3, total: 4 },
            },
          })}::jsonb),
        (${ids.metafile}, ${owner}, 'file', 'memo.docx', ${folder},
          ${JSON.stringify({
            filename: 'memo.docx',
            sha256: 'h',
            indexing_applied: 'full',
            extract_completed_at: later,
            read_cut: {
              pictures_small: { what: 'pictures', read: 3, total: 4 },
              pictures_metafile: { what: 'pictures', read: 3, total: 4 },
            },
          })}::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
  });

  it('the file rows say failed, partial and indexed, whatever indexing_applied says', async () => {
    const rows = await ops.listFiles({ ownerId: owner, parentPath: folder });
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get(ids.refused)?.indexingApplied).toBe('full');
    expect(by.get(ids.refused)?.extraction).toMatchObject({
      state: 'failed',
      reason: 'document_unreadable',
    });
    expect(by.get(ids.partial)?.extraction).toMatchObject({
      state: 'partial',
      pages: { read: 10, total: 679 },
    });
    expect(by.get(ids.read)?.extraction).toEqual({ state: 'indexed' });
    expect(by.get(ids.sheet)?.extraction).toMatchObject({
      state: 'partial',
      cuts: [expect.objectContaining({ key: 'sheet_rows', read: 5000, total: 12000 })],
    });
    expect(by.get(ids.sheet)?.extraction.hint).toMatch(/5,000 of 12,000 rows/);
    expect(by.get(ids.pictures)?.extraction).toMatchObject({
      state: 'partial',
      pictures: { kept: 3, found: 5 },
    });
    expect(by.get(ids.noCut)?.extraction).toEqual({ state: 'indexed' });
    // Icons and small pictures the size gate skipped are details only: the
    // file stays indexed and carries them, with no hint.
    const icons = by.get(ids.icons)?.extraction;
    expect(icons).toMatchObject({
      state: 'indexed',
      cuts: [
        expect.objectContaining({ key: 'pictures_small' }),
        expect.objectContaining({ key: 'pictures_tiny' }),
      ],
    });
    expect(icons?.hint).toBeUndefined();
    // A metafile left out is a cut: partial, its sentence alone in the hint.
    const memo = by.get(ids.metafile)?.extraction;
    expect(memo?.state).toBe('partial');
    expect(memo?.cuts).toHaveLength(2);
    expect(memo?.hint).toMatch(/Windows metafiles/);
    expect(memo?.hint).not.toMatch(/under 200 pixels/);
  });

  it("the stale list's partial is the same rule as the rows' (the exact SQL form)", async () => {
    const { listFilesNeedingAttention } = await import('./ops/stale');
    const page = await listFilesNeedingAttention({
      ownerId: owner,
      state: 'partial',
      installed: [],
    });
    const want = [ids.partial, ids.sheet, ids.pictures, ids.metafile].sort();
    expect(page.files.map((f) => f.id).sort()).toEqual(want);
    expect(page.total).toBe(4);
    for (const f of page.files) expect(f.extraction.state).toBe('partial');
  });

  it('the extraction list finds each file in its state, under a folder or in the tree', async () => {
    const failed = await ops.listFilesByExtraction({ ownerId: owner, state: 'failed' });
    expect(failed.files.map((f) => f.id)).toEqual([ids.refused]);
    expect(failed.truncated).toBe(false);
    const partial = await ops.listFilesByExtraction({
      ownerId: owner,
      state: 'partial',
      under: folder,
    });
    expect(partial.files.map((f) => f.id).sort()).toEqual(
      [ids.partial, ids.sheet, ids.pictures, ids.metafile].sort(),
    );
    const elsewhere = await ops.listFilesByExtraction({
      ownerId: owner,
      state: 'failed',
      under: 'files.nowhere_here',
    });
    expect(elsewhere.files).toEqual([]);
  });

  it('a rename after the verdict keeps it: the content is still not read (audit M1)', async () => {
    // A rename moves updated_at (touch_updated_at) past the verdict and reads
    // nothing: the file must still say failed, and still be listed.
    await m.db.execute(
      sqlTag`update nodes set title = 'spec-book-1 renamed.pdf' where id = ${ids.refused}`,
    );
    const [row] = await ops.filesByIds({ ownerId: owner, ids: [ids.refused] });
    expect(row?.extraction.state).toBe('failed');
    const failed = await ops.listFilesByExtraction({ ownerId: owner, state: 'failed' });
    expect(failed.files.map((f) => f.id)).toEqual([ids.refused]);
  });
});
