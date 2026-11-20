/**
 * Clear the marks the removed name-based version pass left (docs/files.md,
 * "File history"). Until v0.709 the extractor grouped a folder's files whose
 * names differed only in runs of digits and marked all but the newest
 * superseded (`superseded_reason` 'version', salience 0.5, `superseded_by`
 * the newest). Versions are never guessed from file names (owner,
 * 2026-11-20), so every such mark on a file is wrong: the file is down-weighted
 * in search and every hit on it points at another file as its "living"
 * successor.
 *
 * A file node with reason 'version' gets `superseded_by` and
 * `superseded_reason` cleared and salience 1. A 'corrected' or 'migrated'
 * mark (a person's, or a page made from the file) is never touched, nor any
 * node that is not a file. `updated_at` is kept (mantle.keep_updated_at):
 * the clear is no edit of the file, so neither "last updated" nor the
 * extractor's skipped and parked stamps see one (a moved updated_at would
 * queue a skipped file for a paid read). Manual only: no sweep, no cron. No
 * model, no queue: one UPDATE. Output is counts only.
 */
import { sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';

/** A file the removed pass marked. */
const MARKED = sql`${nodes.type} = 'file' and ${nodes.supersededReason} = 'version'`;

/** How many files carry the mark, and how many of those are down-weighted. */
export async function countNameVersionMarks(): Promise<{ marked: number; demoted: number }> {
  const [row] = (await db.execute(sql`
    select count(*)::int as marked,
           count(*) filter (where ${nodes.salience} < 1)::int as demoted
      from ${nodes}
     where ${MARKED}
  `)) as unknown as Array<{ marked: number; demoted: number }>;
  return { marked: row?.marked ?? 0, demoted: row?.demoted ?? 0 };
}

/** Clear every mark: how many files were cleared. A second run clears none. */
export async function clearNameVersionMarks(): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('mantle.keep_updated_at', 'on', true)`);
    const rows = await tx
      .update(nodes)
      .set({ supersededBy: null, supersededReason: null, salience: 1 })
      .where(MARKED)
      .returning({ id: nodes.id });
    return rows.length;
  });
}
