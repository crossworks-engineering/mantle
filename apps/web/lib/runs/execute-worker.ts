/**
 * `worker_invoke` dispatch — CLAIM CONTEXT ONLY since slice 3 WP1. The claim
 * stays exactly where slice 2 put it (`claimWorkerItem`: ready → running CAS
 * under the per-run concurrency cap, run-row lock serializing cap decisions);
 * the TURN itself — route resolution incl. the `'inherit'` sentinel, the
 * agent tool-loop, mechanical evidence, spill, completion — moved to the
 * durable DBOS runner (`apps/api/src/workflows/runs-worker-turn.ts`), where
 * every LLM call and tool dispatch is a journaled step and a crash mid-turn
 * resumes instead of re-running wholesale.
 *
 * Handshake (plan §4 WP1, C4 — engine contract unchanged):
 *   claim wins  → enqueue `runsWorkerTurnWorkflow` on RUNS_TURN_QUEUE
 *                 (the dedicated background-turn queue, off the foreground
 *                 RUNNER_QUEUE; workflowID = itemId:attempt) and ack.
 *                 Fire-and-forget —
 *                 no cross-process await; the workflow completes the item.
 *   enqueue throws → complete the item `failed(dispatch_failed)` IMMEDIATELY
 *                 (honest failure type; no 600 s deadline rot). The sweep's
 *                 deadline duty covers only a crash in the gap between the
 *                 claim committing and the enqueue.
 *   capped / stale → ack, as before (slot-release re-dispatch or the sweep
 *                 re-wakes a capped item).
 */
import { db } from '@mantle/db';
import { claimWorkerItem, completeItem } from '@mantle/runs';

import { enqueueRunsWorkerTurn } from './dbos-enqueue';
import type { ExecuteItemOutcome } from './execute-item';

export async function executeWorkerInvoke(itemId: string): Promise<ExecuteItemOutcome> {
  const { item, capped } = await claimWorkerItem(db, itemId);
  if (!item) return { claimed: false, actions: [], ...(capped ? { capped: true } : {}) };

  try {
    await enqueueRunsWorkerTurn(item.id, item.attempt);
    return { claimed: true, actions: [] };
  } catch (err) {
    // DBOS system DB unreachable while pg-boss is healthy — fail the item
    // now with the true cause instead of letting it rot to a lying
    // `timeout` (plan §8). completeItem drives the counter; the run
    // completes degraded and the responder reports it.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[runs] worker-turn enqueue failed (item ${item.id}): ${message}`);
    const { actions } = await completeItem(db, {
      itemId: item.id,
      state: 'failed',
      failure: {
        type: 'dispatch_failed',
        message: `could not hand the turn to the durable runner: ${message}`,
        itemId: item.id,
      },
    });
    return { claimed: true, actions };
  }
}
