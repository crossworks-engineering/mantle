/**
 * Extraction jobs the workspaces heads check refused (plan V5, 0241): parked
 * once (a stamp on the node, and a row on their own queue), never retried by
 * pg-boss and never re-driven on a start or a provider recovery (the plain
 * dead letter is), so the extraction model is not called again for a write
 * that would fail the same way. An admin's phone hears of it.
 */
import { eq, sql } from 'drizzle-orm';
import { db, extractParkedStamp, isHeadsCheckError, nodes } from '@mantle/db';

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
    /** Stamp `data.extract_parked` on the node: the durable record, which
     *  the boot and recovery drains skip (W1 audit, LOW 4). */
    stamp: (nodeId: string) => Promise<void>;
    /** The row on HEADS_DEAD_QUEUE; null when the queue is gone (the agent
     *  is stopping), and then the stamp alone is the record. */
    park: ((data: { nodeId: string; at: string; error: string }) => Promise<void>) | null;
    /** Raise the "needs you" event so an admin's phone hears of it. */
    alert: () => Promise<void>;
    log: (msg: string) => void;
  },
): Promise<boolean> {
  if (!isHeadsCheckError(err)) return false;
  const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  // The stamp first: it is the record that keeps the drains away, so a
  // missing queue never lets the job complete with nothing parked.
  await deps.stamp(nodeId);
  if (deps.park) await deps.park({ nodeId, at: new Date().toISOString(), error });
  await deps
    .alert()
    .catch((e) =>
      deps.log(`node ${nodeId}: parked-alert notify failed: ${e instanceof Error ? e.message : e}`),
    );
  deps.log(
    `node ${nodeId}: heads check refused a write; parked${deps.park ? ` on ${HEADS_DEAD_QUEUE}` : ' (stamp only, no queue)'}, not retried`,
  );
  return true;
}

/** Merge `data.extract_parked = { at: now() }` onto the node. Leaves
 *  `updated_at` alone, like the terminal skip stamp. A plain data update: it
 *  touches no access column, so it needs no heads (plan V2). */
export async function stampExtractParked(nodeId: string): Promise<void> {
  await db
    .update(nodes)
    .set({ data: sql`coalesce(${nodes.data}, '{}'::jsonb) || ${extractParkedStamp()}` })
    .where(eq(nodes.id, nodeId));
}

/** The "needs you" event (migration 0186, @mantle/content needs-you.ts): the
 *  push worker reads the parked count and pushes a new one to admin devices.
 *  Notify only; nothing that listens starts LLM work. */
export async function notifyParked(ownerId: string): Promise<void> {
  await db.execute(sql`SELECT pg_notify('needs_you_changed', ${ownerId}::text)`);
}
