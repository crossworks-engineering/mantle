/**
 * The read's cuts onto the node (docs/files.md, "Read in part"): what the
 * readers said in the sink of this extract (@mantle/files read-cut-sink.ts),
 * written with the stamp that ends the read (../extractor.ts
 * stampExtractCompleted, ./gates.ts indexLocalOnly).
 */
import { sql } from 'drizzle-orm';
import { db, FILE_READ_PARTIAL_CHANNEL, nodes } from '@mantle/db';
import { currentReadCuts } from '@mantle/files/read-cut-sink';
import { log } from '@mantle/tracing';
import { errorMessage } from '@mantle/std';

/**
 * The cuts said in this read, merged onto the node's own (docs/files.md,
 * "Read in part"), as a `|| ...` to put after a data write; nothing when none
 * was said. Merged, not replaced: a read from the stored text (a retry after
 * a paid OCR or vision read) runs no reader, and the cuts of the read that
 * made the text stay. A key said again replaces its entry. New bytes and a
 * reindex drop the key whole (BYTE_DERIVED_DATA_KEYS), so a cut of old bytes
 * never outlives them.
 */
export function readCutStampSql(): ReturnType<typeof sql> {
  const cuts = currentReadCuts();
  if (Object.keys(cuts).length === 0) return sql``;
  return sql` || jsonb_build_object('read_cut',
      (case when jsonb_typeof(${nodes.data}->'read_cut') = 'object'
            then ${nodes.data}->'read_cut' else '{}'::jsonb end) || ${JSON.stringify(cuts)}::jsonb)`;
}

/** After a file's read wrote cuts: the admins' phones hear of it (the push
 *  worker, FILE_READ_PARTIAL_CHANNEL, throttled there). Notify only: nothing
 *  that listens starts model work. Best effort: a lost notice only means no
 *  push. */
export async function notifyReadPartial(node: { type: string; ownerId: string }): Promise<void> {
  if (node.type !== 'file' || Object.keys(currentReadCuts()).length === 0) return;
  try {
    await db.execute(sql`SELECT pg_notify(${FILE_READ_PARTIAL_CHANNEL}, ${node.ownerId}::text)`);
  } catch (err) {
    log('extractor').error(`read-partial notify failed: ${errorMessage(err)}`);
  }
}
