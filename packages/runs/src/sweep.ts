/**
 * The runs sweep — the engine's immune system (§5b). Runs every minute from
 * the runs worker (own pg-boss cron, NOT the nightly maintenance cron — too
 * coarse). Three duties, all expressed as ordinary engine operations so they
 * compose with the completion counter instead of bypassing it:
 *
 *   1. Overdue `ready`/`running` items → `failed(timeout)` via completeItem —
 *      drives the counter forward like any completion. Nothing wedges.
 *   2. Stale `ready` items (no state change for a grace window) → re-emit the
 *      dispatch action. Covers a crash between commit and enqueue, and pg-boss
 *      archive loss — this replaces transactional-outbox machinery. A
 *      duplicate wake-up no-ops at the claim CAS.
 *   3. Terminal root groups never resumed (`resumed_at IS NULL`) → re-emit the
 *      resume action. Covers a lost resume job; the resume handler's CAS on
 *      `resumed_at` keeps it at-most-once.
 *
 * Pure DB logic — returns actions for the caller to enqueue. (Budget /
 * item-cap pause lands with slice 3.)
 */
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { runItems, runs, type Db } from '@mantle/db';

import { completeItem, type PostCommitAction } from './engine';
import { RUN_TOOL_QUEUE, RUN_WORKER_QUEUE } from './queues';

/** How long a `ready` item may sit unclaimed before we assume its dispatch
 *  job was lost. Comfortably above queue latency; far below human patience. */
const READY_STALE_SECONDS = 90;
/** How long a terminal, never-resumed root may sit before the resume is
 *  re-sent. Covers the singletonKey window of the original send. */
const RESUME_STALE_SECONDS = 120;

export type SweepResult = {
  timedOut: number;
  redispatched: number;
  resumesResent: number;
  actions: PostCommitAction[];
};

export async function sweepRuns(db: Db): Promise<SweepResult> {
  const actions: PostCommitAction[] = [];

  // 1. Deadline enforcement. Deadlines mean EXECUTION budget: stamped at
  //    claim for dispatched leaves (so cap-waiting/ready limbo burns
  //    nothing), at promotion for audits (verdict budget — audits are never
  //    claimed). completeItem's CAS makes racing the real completion
  //    harmless — whoever loses no-ops.
  const overdue = await db
    .select({ id: runItems.id })
    .from(runItems)
    .where(
      and(
        sql`(${runItems.state} = 'running' or (${runItems.state} = 'ready' and ${runItems.kind} = 'audit'))`,
        lt(runItems.deadlineAt, sql`now()`),
      ),
    )
    .limit(200);
  let timedOut = 0;
  for (const { id } of overdue) {
    const res = await completeItem(db, {
      itemId: id,
      state: 'failed',
      failure: { type: 'timeout', message: 'deadline exceeded (runs sweep)', itemId: id },
    });
    if (res.completed) {
      timedOut++;
      actions.push(...res.actions);
    }
  }

  // 2. Lost dispatch heal. updated_at moves on promote and on claim, so a
  //    ready row untouched for the grace window has no live job working it.
  //    Audits are excluded — they're resume-driven, not dispatchable (2b).
  const staleReady = await db
    .select({ id: runItems.id, kind: runItems.kind, sideEffecting: runItems.sideEffecting })
    .from(runItems)
    .where(
      and(
        eq(runItems.state, 'ready'),
        sql`${runItems.kind} <> 'audit'`,
        lt(runItems.updatedAt, sql`now() - make_interval(secs => ${READY_STALE_SECONDS})`),
      ),
    )
    .limit(200);
  for (const item of staleReady) {
    actions.push({
      type: 'dispatch',
      queue: item.kind === 'worker_invoke' ? RUN_WORKER_QUEUE : RUN_TOOL_QUEUE,
      itemId: item.id,
      sideEffecting: item.sideEffecting,
    });
    // Touch the row so the next sweep doesn't re-emit while this wake-up is
    // still in flight.
    await db
      .update(runItems)
      .set({ updatedAt: sql`now()` })
      .where(and(eq(runItems.id, item.id), eq(runItems.state, 'ready')));
  }

  // 2b. Lost AUDIT resume heal: a ready audit no resume turn ever claimed
  //     (resumed_at NULL) past the grace window → re-send its resume
  //     (singletonKey = item id dedupes; claimResume keeps it at-most-once).
  //     A CLAIMED-but-crashed audit is duty 1's territory via its deadline.
  const staleAudits = await db
    .select({ id: runItems.id, runId: runItems.runId })
    .from(runItems)
    .where(
      and(
        eq(runItems.state, 'ready'),
        eq(runItems.kind, 'audit'),
        isNull(runItems.resumedAt),
        lt(runItems.updatedAt, sql`now() - make_interval(secs => ${RESUME_STALE_SECONDS})`),
      ),
    )
    .limit(50);
  for (const a of staleAudits) {
    actions.push({ type: 'resume', runId: a.runId, groupId: a.id });
    await db
      .update(runItems)
      .set({ updatedAt: sql`now()` })
      .where(and(eq(runItems.id, a.id), eq(runItems.state, 'ready')));
  }

  // 3. Lost resume heal. Only for runs that finished properly (done|failed) —
  //    a cancelled run never resumes.
  const unresumed = await db
    .select({ rootId: runItems.id, runId: runItems.runId })
    .from(runItems)
    .innerJoin(runs, eq(runs.id, runItems.runId))
    .where(
      and(
        isNull(runItems.parentId),
        inArray(runItems.state, ['done', 'failed', 'cancelled']),
        isNull(runItems.resumedAt),
        lt(runItems.finishedAt, sql`now() - make_interval(secs => ${RESUME_STALE_SECONDS})`),
        inArray(runs.status, ['done', 'failed']),
      ),
    )
    .limit(50);
  for (const row of unresumed) {
    actions.push({ type: 'resume', runId: row.runId, groupId: row.rootId });
  }

  return {
    timedOut,
    redispatched: staleReady.length,
    resumesResent: unresumed.length + staleAudits.length,
    actions,
  };
}

/**
 * The resume handler's idempotency gate: CAS `resumed_at` on the group row.
 * Returns true exactly once per group — duplicates (redelivery, sweep re-send
 * racing the original) get false and must ack without running a turn.
 * At-most-once by design: marking BEFORE the turn means a crash mid-turn
 * loses that resume rather than ever double-running it.
 */
export async function claimResume(db: Db, groupId: string): Promise<boolean> {
  const [row] = await db
    .update(runItems)
    .set({ resumedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(runItems.id, groupId), isNull(runItems.resumedAt)))
    .returning({ id: runItems.id });
  return !!row;
}
