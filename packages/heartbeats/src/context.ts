/**
 * AsyncLocalStorage for the heartbeat the current tool loop is
 * executing under. Read by heartbeat_complete / heartbeat_snooze /
 * heartbeat_update_state in tools.ts as the fallback addressing
 * source when no `slug` arg is passed.
 *
 * Carries `depth` to cap chained `heartbeat_fire` invocations: a
 * skill that calls heartbeat_fire(<other slug>) from inside its own
 * fire opens a child fire at depth+1; same enforcement model as
 * @mantle/tools' MAX_AGENT_DEPTH. Direct self-recursion
 * (heartbeat_fire(<own slug>) inside its own fire) is rejected
 * earlier with a clearer error.
 *
 * Same pattern as @mantle/tracing's currentTrace() — independent
 * ALSes, both inherit through awaits.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

type HeartbeatCtx = {
  heartbeatId: string;
  /** The heartbeat's slug, captured at withHeartbeatContext time so
   *  heartbeat_fire can detect a self-recursion attempt without an
   *  extra DB lookup. */
  slug: string;
  ownerId: string;
  /** Chain depth. 1 = entry-point fire. Increments by 1 for each
   *  child fire opened via heartbeat_fire from within an existing
   *  fire. Capped at MAX_HEARTBEAT_DEPTH (3). */
  depth: number;
};

/** Maximum allowed depth for chained heartbeat_fire calls. 3 is
 *  enough for "A fires B fires C" without enabling pathological
 *  cycles. Mirrors MAX_AGENT_DEPTH's conservatism. */
export const MAX_HEARTBEAT_DEPTH = 3;

const store = new AsyncLocalStorage<HeartbeatCtx>();

export function currentHeartbeat(): HeartbeatCtx | null {
  return store.getStore() ?? null;
}

/**
 * Open a heartbeat context for the duration of `fn`. Auto-derives
 * the next depth from any outer context — so callers don't need to
 * track it manually. Call sites (fire.ts) typically pass
 * heartbeatId + slug + ownerId only.
 */
export function withHeartbeatContext<T>(
  ctx: { heartbeatId: string; slug: string; ownerId: string; depth?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const parent = currentHeartbeat();
  const depth = ctx.depth ?? (parent ? parent.depth + 1 : 1);
  return store.run({ ...ctx, depth }, fn);
}
