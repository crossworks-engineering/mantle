/**
 * A file the parser refused shows as failed (task 8d40932a), on a real,
 * migrated Postgres. The case from a client box: a 347 MB scanned PDF, past
 * the parser's PDF limit, got `extract_skipped: document_unreadable`, while
 * `indexing_applied` still said 'full' and nothing on any screen said its
 * content was missing. Now its file row says `failed` with the reason, the
 * `extraction` list finds it, also after a rename. A scan the OCR read 10
 * pages of is `partial`. Seeds its own owner and rows
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
  const ids = { refused: randomUUID(), partial: randomUUID(), read: randomUUID() };
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
    expect(partial.files.map((f) => f.id)).toEqual([ids.partial]);
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
