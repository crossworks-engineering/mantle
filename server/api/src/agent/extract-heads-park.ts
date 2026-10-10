/**
 * Extraction jobs the workspaces heads check refused (plan V5, 0241): parked
 * once on their own queue, never retried by pg-boss and never re-driven on a
 * start or a provider recovery (the plain dead letter is), so the extraction
 * model is not called again for a write that would fail the same way.
 */
import { isHeadsCheckError } from '@mantle/db';

/** The parking queue; /debug/integrity lists what waits on it. */
export const HEADS_DEAD_QUEUE = 'mantle.extract.heads';

/**
 * Park a job the heads check refused (plan V5): one row on HEADS_DEAD_QUEUE,
 * and true, so the job completes and pg-boss does not retry it (each retry
 * would run the extraction LLM again). Any other error: false, and the
 * caller rethrows into the normal retry and dead-letter path.
 */
export async function parkHeadsFailure(
  err: unknown,
  nodeId: string,
  deps: {
    park: (data: { nodeId: string; at: string; error: string }) => Promise<void>;
    log: (msg: string) => void;
  },
): Promise<boolean> {
  if (!isHeadsCheckError(err)) return false;
  const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  await deps.park({ nodeId, at: new Date().toISOString(), error });
  deps.log(
    `node ${nodeId}: heads check refused a write; parked on ${HEADS_DEAD_QUEUE}, not retried`,
  );
  return true;
}
