/**
 * Worker-side DBOS enqueue seam (slice 3 WP1). The runs WORKER process (a
 * plain tsx process, not Next.js) enqueues turn workflows onto the shared
 * RUNNER_QUEUE by name — registering and executing them is apps/api's job.
 *
 * Deliberately NOT `@/lib/dbos-client`: that module is `server-only` (throws
 * outside a React server bundle). Same pattern underneath — one cached
 * DBOSClient (a pg pool on the DBOS system DB), config from the same
 * `resolveSystemDatabaseUrl()` both processes already share. A failed create
 * must not poison the process: the cache clears on rejection so the next
 * wake-up retries (the caller fails the ITEM honestly either way).
 *
 * workflowID = `<itemId>:<attempt>` (see RUNS_WORKER_TURN_WORKFLOW in
 * @mantle/runs): idempotent per semantic attempt — a duplicate wake-up for
 * the same attempt dedupes at the DBOS layer, while a retry (attempt bumped
 * by requeueForRetry) gets a fresh workflow — and deterministically
 * derivable from the item row for observability.
 */
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { resolveSystemDatabaseUrl, RUNNER_QUEUE } from '@mantle/assistant-runtime';
import {
  RUNS_WORKER_TURN_WORKFLOW,
  type RunsWorkerTurnInput,
  type RunsWorkerTurnResult,
} from '@mantle/runs';

let clientPromise: Promise<DBOSClient> | null = null;

function getClient(): Promise<DBOSClient> {
  if (!clientPromise) {
    clientPromise = DBOSClient.create({ systemDatabaseUrl: resolveSystemDatabaseUrl() });
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

/** Fire-and-forget enqueue of a claimed worker item's turn. Throws when the
 *  DBOS system DB is unreachable — the caller completes the item
 *  `failed(dispatch_failed)` immediately (plan §8: honest failure type, no
 *  600 s deadline rot; the sweep covers only the crash-between-claim-and-
 *  enqueue window). */
export async function enqueueRunsWorkerTurn(itemId: string, attempt: number): Promise<void> {
  const client = await getClient();
  await client.enqueue<(input: RunsWorkerTurnInput) => Promise<RunsWorkerTurnResult>>(
    {
      workflowName: RUNS_WORKER_TURN_WORKFLOW,
      queueName: RUNNER_QUEUE,
      workflowID: `${itemId}:${attempt}`,
    },
    { itemId },
  );
}
