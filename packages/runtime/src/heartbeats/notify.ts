/**
 * pg_notify wake-up for newly-created or just-edited heartbeats.
 *
 * Default UX without this: a freshly-created heartbeat with
 * `next_fire_at` in the immediate future waits up to TICK_INTERVAL
 * (60s) before the agent's tick loop picks it up. For most heartbeats
 * that's fine; for the operator clicking "Create" expecting the
 * heartbeat to be live, 60s feels like a bug.
 *
 * Fix: lib code that writes a heartbeat row with a relevant change
 * (insert; resume-from-paused; status change to active) fires
 * pg_notify('heartbeat_due', <ownerId>). server/api LISTENs and
 * runs tickHeartbeats(ownerId) on each notification — same code
 * path as the 60s setInterval, just kicked early.
 *
 * NEW-7 from the v1 audit.
 *
 * Channel name is plain 'heartbeat_due'. The payload is the owner
 * id so a future multi-tenant config can scope per-owner; today
 * the single-user listener just calls tickHeartbeats(USER_ID)
 * regardless, but we still pass owner so the contract holds.
 *
 * Fire-and-forget. A pg_notify failure (DB hiccup) is logged and
 * swallowed — the next regular tick will catch the row anyway, so
 * losing the notify is at most a 60-second UX regression, never a
 * correctness issue. Same soft-fail discipline as @mantle/tracing.
 */

import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';

/** The Postgres channel server/api LISTENs on. Exported so the
 *  listener and the notifiers reference the same string — typo
 *  protection. */
export const HEARTBEAT_DUE_CHANNEL = 'heartbeat_due';

/**
 * Wake the tick loop for a given owner. Call this immediately after:
 *   - createHeartbeat inserts a row (esp. when next_fire_at is now-ish)
 *   - updateHeartbeat re-activates a paused/completed/cancelled row
 *   - a forceFire is initiated (so the operator's Zap click reflects
 *     in the trace within a second, not after the next tick)
 *
 * Soft-failing: never throws. The next regular tick will still pick
 * up the row, so losing one notify is at most a 60-second delay.
 */
export async function notifyHeartbeatDue(ownerId: string): Promise<void> {
  try {
    // The channel name is a string literal (no operator-controlled
    // value) and the payload is parameterised — safe from injection.
    await db.execute(sql`SELECT pg_notify(${HEARTBEAT_DUE_CHANNEL}, ${ownerId})`);
  } catch (err) {
    console.error(
      `[heartbeats:notify] pg_notify failed (next regular tick will catch up):`,
      err instanceof Error ? err.message : err,
    );
  }
}
