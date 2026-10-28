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
import { db, nodes, extractSkippedStamp, dropIndexWork, readIndexWork } from '@mantle/db';
import { recordSkippedTrace } from '@mantle/tracing';

/** A skip trace's fields, with the node it is about. */
export type SkipInit = Parameters<typeof recordSkippedTrace>[0] & { subjectId: string };

/** Record the skip trace, then stamp the node terminal. `node` is the row as
 *  the job loaded it: its work stamp is the one the verdict answers. `extra`
 *  goes on the stamp beside its reason (extractSkippedStamp). */
export async function recordTerminalSkip(
  init: SkipInit,
  node: { readonly data: unknown },
  extra?: Record<string, string>,
): Promise<void> {
  await recordSkippedTrace(init);
  await stampExtractSkipped(init.subjectId, init.disposition, readIndexWork(node.data), extra);
}

/** Merge `data.extract_skipped = { reason, at: now() }` onto the node, and
 *  drop the work a reset stamped (A10 #7, `data.index_work`): the verdict is
 *  the answer to it, so a later rename re-embeds without a model call. Only
 *  the stamp the job saw (`seen`) is dropped: a content change that landed
 *  while the job ran keeps its 'extract' stamp for its own job, so a rename
 *  before that job runs still summarises the new content (fix round 2, L6;
 *  dropIndexWork says what a value check cannot tell apart). Leaves
 *  `updated_at` alone: the stamp must not look like a content change. Best
 *  effort: a failed stamp only means the drain re-queues the node once more. */
export async function stampExtractSkipped(
  nodeId: string,
  reason: string,
  seen: ReturnType<typeof readIndexWork>,
  extra?: Record<string, string>,
): Promise<void> {
  try {
    await db
      .update(nodes)
      .set({
        data: sql`${dropIndexWork(nodes.data, seen)} || ${extractSkippedStamp(reason, extra)}`,
      })
      .where(eq(nodes.id, nodeId));
  } catch (err) {
    console.error(
      `[extractor] terminal-skip stamp failed for ${nodeId.slice(0, 8)}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
