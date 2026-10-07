/**
 * Extractor: terminal skips.
 *
 * A skip that is a verdict on the node's CONTENT (nothing to read in it) is
 * recorded as a trace like any other skip, and is also stamped on the node as
 * `data.extract_skipped`, so the boot drain and the provider circuit's
 * recovery drain stop re-queuing it until the node changes (@mantle/db
 * extract-exempt.ts has the rule and the 2026-10-04 history). A skip caused by
 * the machinery (a worker that did not run, a rasterizer that threw) uses the
 * plain `recordSkippedTrace` so the drain retries it.
 */

import { eq, sql } from 'drizzle-orm';
import { db, nodes, extractSkippedStamp } from '@mantle/db';
import { recordSkippedTrace } from '@mantle/tracing';

type SkipInit = Parameters<typeof recordSkippedTrace>[0] & { subjectId: string };

/** Record the skip trace, then stamp the node terminal. */
export async function recordTerminalSkip(init: SkipInit): Promise<void> {
  await recordSkippedTrace(init);
  await stampExtractSkipped(init.subjectId, init.disposition);
}

/** Merge `data.extract_skipped = { reason, at: now() }` onto the node. Leaves
 *  `updated_at` alone: the stamp must not look like a content change. Best
 *  effort: a failed stamp only means the drain re-queues the node once more. */
export async function stampExtractSkipped(nodeId: string, reason: string): Promise<void> {
  try {
    await db
      .update(nodes)
      .set({ data: sql`coalesce(${nodes.data}, '{}'::jsonb) || ${extractSkippedStamp(reason)}` })
      .where(eq(nodes.id, nodeId));
  } catch (err) {
    console.error(
      `[extractor] terminal-skip stamp failed for ${nodeId.slice(0, 8)}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
