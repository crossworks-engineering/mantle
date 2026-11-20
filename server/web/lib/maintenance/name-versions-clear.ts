/**
 * Clear the marks the removed name-based version pass left (docs/files.md,
 * "File history"). Until v0.709 the extractor grouped a folder's files whose
 * names differed only in runs of digits and marked all but the newest
 * superseded (`superseded_reason` 'version', salience 0.5, `superseded_by`
 * the newest, a file in the same folder). Versions are never guessed from
 * file names (owner, 2026-11-20), so every such mark on a file is wrong: the
 * file is down-weighted in search and every hit on it points at another file
 * as its "living" successor.
 *
 * A file node with reason 'version' whose `superseded_by` is a file in the
 * same folder (the same parent_id: the shape the old pass wrote) gets
 * `superseded_by` and `superseded_reason` cleared and salience 1. Any other
 * 'version' mark (one set by hand through content_supersede, to a page or to
 * a file in another folder) is left, and counted as left. A 'corrected' or
 * 'migrated' mark is never touched, nor any node that is not a file.
 * `updated_at` is kept (mantle.keep_updated_at): the clear is no edit of the
 * file, so neither "last updated" nor the extractor's skipped and parked
 * stamps see one (a moved updated_at would queue a skipped file for a paid
 * read). Manual only: no sweep, no cron. No model, no queue: one UPDATE.
 * Output is counts only.
 */
import { sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';

/** A file marked 'version'. */
const VERSION = sql`${nodes.type} = 'file' and ${nodes.supersededReason} = 'version'`;

/** The removed pass's shape: the successor is a file in the same folder.
 *  The outer row is named `nodes` in full (both the count and the UPDATE
 *  read the table by that name), so no column here can bind to `s`. */
const OLD_SHAPE = sql`exists (select 1 from nodes s
                               where s.id = nodes.superseded_by
                                 and s.type = 'file'
                                 and s.parent_id is not distinct from nodes.parent_id)`;

/** How many files carry the old pass's mark (to clear), and how many other
 *  'version' marks stay (left). */
export async function countNameVersionMarks(): Promise<{ toClear: number; left: number }> {
  const [row] = (await db.execute(sql`
    select count(*) filter (where ${OLD_SHAPE})::int as "toClear",
           count(*) filter (where not ${OLD_SHAPE})::int as "left"
      from ${nodes}
     where ${VERSION}
  `)) as unknown as Array<{ toClear: number; left: number }>;
  return { toClear: row?.toClear ?? 0, left: row?.left ?? 0 };
}

/** Clear every mark of the old shape: how many files were cleared. A second
 *  run clears none. */
export async function clearNameVersionMarks(): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('mantle.keep_updated_at', 'on', true)`);
    const rows = await tx
      .update(nodes)
      .set({ supersededBy: null, supersededReason: null, salience: 1 })
      .where(sql`${VERSION} and ${OLD_SHAPE}`)
      .returning({ id: nodes.id });
    return rows.length;
  });
}
