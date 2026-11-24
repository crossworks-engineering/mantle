/**
 * Stamp the read cut `scan_pages` on the PDF files whose sketch read left
 * scan pages not read (docs/file-ingestion.md, 3b). Until 2026-11-24 the
 * sketch read of a scanned drawing took at most 10 pages of a file and said
 * no cut, so such a file counts as read in full (files:coverage) though its
 * database states the pages past the cap. This puts the cut on it from its
 * own File tab (`Scan pages read`, and `Scan pages not read`, or on an older
 * database `Scan pages past the cap`), so the file is `partial` and the
 * coverage counts it as not read in full. A person then reads the rest with
 * a read again (`file_reindex`).
 *
 * One check a file: its database for its current bytes holds a sketch read
 * that left pages not read, and the node has no `scan_pages` cut yet. A
 * file whose File tab cannot be read is counted, never stamped. The write
 * is conditional on the same bytes and keeps `updated_at`
 * (mantle.keep_updated_at): the stamp is no edit of the file, so nothing
 * queues a read of it. Manual only: no sweep, no cron, no model, no queue.
 * Output is counts only.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { storedPdfOf } from '@mantle/content/pdf-read';
import { db, nodes } from '@mantle/db';
import { fileDbSqlitePath, isFileSha256 } from '@mantle/files';
import type { ReadCutValue } from '@mantle/files/read-cut';

/** What a run found, in counts. */
export type ScanPagesStampCounts = {
  /** PDF files with no `scan_pages` cut and a sha256. */
  pdfs: number;
  /** Of those, with a database that holds a sketch read. */
  sketched: number;
  /** Of those, read in part: to stamp (or stamped, with apply). */
  partial: number;
  /** Stamped by this run (0 on a dry run). */
  stamped: number;
  /** A database with no drawing File tab read: not a drawing database (a
   *  book's, another Reader's), or one busy now. */
  unreadable: number;
};

/** The cut a stored File tab says, or null when it read every scan page. */
export function scanPagesCutOf(file: {
  visionRead: boolean;
  scanPagesRead: number;
  scanPagesNotRead: number;
}): ReadCutValue | null {
  if (!file.visionRead || file.scanPagesNotRead <= 0) return null;
  return {
    what: 'pages',
    read: file.scanPagesRead,
    total: file.scanPagesRead + file.scanPagesNotRead,
  };
}

/** PDF files of the box with no `scan_pages` cut yet. */
const CANDIDATES = and(
  eq(nodes.type, 'file'),
  isNull(nodes.supersededBy),
  sql`coalesce(${nodes.data}->>'snapshot_of', '') = ''`,
  sql`(lower(coalesce(${nodes.data}->>'filename', ${nodes.title})) like '%.pdf'
       or ${nodes.data}->>'mimeType' = 'application/pdf')`,
  sql`not coalesce(${nodes.data}->'read_cut' ? 'scan_pages', false)`,
);

/** Count the files read in part, and with `apply` stamp their cut. */
export async function stampScanPages(apply: boolean): Promise<ScanPagesStampCounts> {
  const rows = await db
    .select({ id: nodes.id, sha: sql<unknown>`${nodes.data}->>'sha256'` })
    .from(nodes)
    .where(CANDIDATES);
  const out: ScanPagesStampCounts = { pdfs: 0, sketched: 0, partial: 0, stamped: 0, unreadable: 0 };
  for (const row of rows) {
    if (!isFileSha256(row.sha)) continue;
    out.pdfs += 1;
    const abs = await fileDbSqlitePath(row.id, row.sha);
    if (!abs) continue;
    const file = await storedPdfOf(abs);
    if (!file) {
      out.unreadable += 1;
      continue;
    }
    if (!file.visionRead) continue;
    out.sketched += 1;
    const cut = scanPagesCutOf(file);
    if (!cut) continue;
    out.partial += 1;
    if (!apply) continue;
    const done = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('mantle.keep_updated_at', 'on', true)`);
      return tx
        .update(nodes)
        .set({
          data: sql`${nodes.data} || jsonb_build_object('read_cut',
            (case when jsonb_typeof(${nodes.data}->'read_cut') = 'object'
                  then ${nodes.data}->'read_cut' else '{}'::jsonb end)
            || jsonb_build_object('scan_pages', ${JSON.stringify(cut)}::jsonb))`,
        })
        .where(and(eq(nodes.id, row.id), sql`${nodes.data}->>'sha256' = ${row.sha}`, CANDIDATES))
        .returning({ id: nodes.id });
    });
    out.stamped += done.length;
  }
  return out;
}
