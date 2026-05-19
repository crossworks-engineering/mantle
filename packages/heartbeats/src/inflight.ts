/**
 * In-flight tracker — prevents two concurrent fires of the same
 * heartbeat. Shared between `tickFire` (the minute-cadence loop)
 * and `forceFire` (UI "Fire now" button + the heartbeat_fire tool)
 * so an operator click during a slow LLM call doesn't fire the
 * heartbeat twice.
 *
 * P0-2 from the v1 audit: a fire that takes longer than the tick
 * interval (60s) would be re-selected by the next tick because the
 * schedule's `next_fire_at` doesn't get updated until AFTER the
 * LLM round-trip completes. Same risk for a manual "fire now"
 * landing while tick is mid-fire.
 *
 * Pattern mirrors `inflight` in apps/agent/src/main.ts — a
 * `Map<lockKey, Promise>`. Lookups are O(1); the map only ever
 * holds active fires (typically 0, occasionally a handful).
 *
 * The lock is **per process**. Multiple agent processes pointing
 * at the same DB would still race — at that scale we'd switch to
 * a Postgres advisory lock. Single-process is the only deployment
 * shape today (apps/agent runs as a singleton).
 */

const FIRES_INFLIGHT = new Map<string, Promise<unknown>>();

/** Returns true if a fire for this heartbeat id is currently
 *  running in this process. Tick uses this to filter the due
 *  batch before calling fireInner. */
export function isFireInflight(heartbeatId: string): boolean {
  return FIRES_INFLIGHT.has(heartbeatId);
}

/**
 * Run `fn` under the lock for `heartbeatId`. If a fire for the
 * same id is already running, this waits for it to complete and
 * THEN runs `fn`. (We chose serialise-rather-than-skip for force
 * fires because the caller asked for a fire and would expect one;
 * tick callers use isFireInflight() to skip instead.)
 *
 * The map entry is set before fn runs and deleted in a finally
 * block. Errors propagate to the caller — the lock is purely
 * about exclusion, not error handling.
 */
export async function runWithInflightLock<T>(
  heartbeatId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = FIRES_INFLIGHT.get(heartbeatId);
  if (existing) {
    // Wait for the in-flight fire to finish, ignore its result/error
    // (it has its own caller). Then we acquire the lock ourselves.
    await existing.catch(() => undefined);
  }

  let release!: () => void;
  const lockPromise = new Promise<void>((res) => {
    release = res;
  });
  FIRES_INFLIGHT.set(heartbeatId, lockPromise);

  try {
    return await fn();
  } finally {
    // Order matters: release the promise FIRST so any awaiter wakes
    // up, then delete the map entry so a fresh acquire can store a
    // new promise without a race.
    release();
    if (FIRES_INFLIGHT.get(heartbeatId) === lockPromise) {
      FIRES_INFLIGHT.delete(heartbeatId);
    }
  }
}
