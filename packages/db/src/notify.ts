import { sql } from 'drizzle-orm';
import { db } from './client';

/**
 * Announce that a content node was created, or had its content change, so the
 * extractor (re-)indexes it (summary + embedding + facts; vision for images;
 * parse for documents).
 *
 * This is the explicit companion to migration 0018's `node_ingested` trigger,
 * which is **AFTER INSERT only**. So:
 *   - a fresh INSERT of a non-branch node notifies automatically (trigger);
 *   - any code that UPDATES a node's content, or wants to force a re-index,
 *     MUST call this — the trigger does not fire on UPDATE.
 *
 * Best-effort: a failed notify only delays re-indexing, so it never throws —
 * the caller's primary write (the row) is what matters.
 */
export async function notifyNodeIngested(nodeId: string): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_notify('node_ingested', ${nodeId}::text)`);
  } catch (err) {
    console.error('[db] notifyNodeIngested failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Announce that a node was just (re-)indexed — the extractor finished writing
 * `data.summary` + `embedding`. Distinct channel from `node_ingested` on
 * purpose: that one drives the extractor, so re-using it here would loop the
 * extractor on its own output. This channel is for *readers* — the realtime
 * bridge fans it out to live UI so a freshly-summarised file repaints without a
 * manual refresh. Best-effort: a missed notify only costs a manual refresh.
 */
export async function notifyNodeIndexed(nodeId: string): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_notify('node_indexed', ${nodeId}::text)`);
  } catch (err) {
    console.error('[db] notifyNodeIndexed failed:', err instanceof Error ? err.message : err);
  }
}
