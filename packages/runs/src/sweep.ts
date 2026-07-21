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
 *   4. ask_human row janitor (WP3): pending rows whose item went terminal
 *      expire — the approval surface never outlives the question.
 *
 * Pure DB logic — returns actions for the caller to enqueue. (Budget /
 * item-cap pause lands with WP4.)
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
  /** Pending ask_human rows expired because their item went terminal (4). */
  questionsExpired: number;
  /** Decided-but-unsettled runner rows reverted to pending (4c — the
   *  crash-mid-settle window; final audit F3). */
  settlesReverted: number;
  actions: PostCommitAction[];
};

export async function sweepRuns(db: Db): Promise<SweepResult> {
  const actions: PostCommitAction[] = [];

  // 1. Deadline enforcement. Deadlines mean EXECUTION budget: stamped at
  //    claim for dispatched leaves (so cap-waiting/ready limbo burns
  //    nothing), at promotion for audits (verdict budget — audits are never
  //    claimed). completeItem's CAS makes racing the real completion
  //    harmless — whoever loses no-ops.
  //    Ready-but-undispatchable kinds time out too when DATED: audits
  //    (verdict budget) and ask_human items whose plan set timeout_seconds
  //    (WP3 amendment 3 — without this a dated question could never
  //    expire). Undated ask_human rows have NULL deadlines and never match.
  //    Pause semantics (WP4 amendment 3): RUNNING items keep their clocks
  //    even on a paused run (pause can't abort in-flight work; a hung item
  //    must stay killable) — but READY audit/question deadlines freeze
  //    while paused (nothing is executing; resume shifts them by the paused
  //    duration).
  const overdue = await db
    .select({ id: runItems.id })
    .from(runItems)
    .innerJoin(runs, eq(runs.id, runItems.runId))
    .where(
      and(
        sql`(${runItems.state} = 'running' or (${runItems.state} = 'ready' and ${runItems.kind} in ('audit', 'ask_human') and ${runs.status} <> 'paused'))`,
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
  //    Audits are excluded (resume-driven, not dispatchable — 2b), and so
  //    are ask_human items (HUMAN-driven, never dispatchable — WP3/C6; a
  //    re-dispatch would be 90-second noise forever on an undated question).
  //    Paused runs are skipped (WP4): re-dispatching work whose claim will
  //    refuse is churn for nothing — the budget resume re-emits inline.
  const staleReady = await db
    .select({ id: runItems.id, kind: runItems.kind, sideEffecting: runItems.sideEffecting })
    .from(runItems)
    .innerJoin(runs, eq(runs.id, runItems.runId))
    .where(
      and(
        eq(runItems.state, 'ready'),
        eq(runs.status, 'running'),
        sql`${runItems.kind} not in ('audit', 'ask_human')`,
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
    .innerJoin(runs, eq(runs.id, runItems.runId))
    .where(
      and(
        eq(runItems.state, 'ready'),
        eq(runItems.kind, 'audit'),
        eq(runs.status, 'running'), // paused runs: the budget resume re-sends
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

  // 4. ask_human row janitor (WP3 amendment 2 — the pending row and the
  //    item are separate stores; every item-killing path relies on THIS
  //    duty to expire the surface). A pending 'ask_human' row whose item is
  //    already terminal (run cancelled, fail_fast cancelled the branch,
  //    duty 1 timed a dated question out) expires with a teaching message,
  //    so zombie questions never accumulate in the pending UI / telegram
  //    flow. The answer path handles the inverse race (approval landing on
  //    a terminal item) itself; this is the janitor of last resort.
  const expired = (await db.execute(sql`
    UPDATE pending_tool_calls p
    SET status = 'expired', decided_at = now(), updated_at = now(),
        error = 'the run moved on (cancelled, timed out, or completed) before an answer'
    WHERE p.status = 'pending'
      AND p.tool_slug = 'ask_human'
      AND (p.args->>'item_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND EXISTS (
        SELECT 1 FROM run_items ri
        WHERE ri.id = (p.args->>'item_id')::uuid
          AND ri.state IN ('done', 'failed', 'cancelled', 'superseded')
      )
    RETURNING p.id
  `)) as unknown as Array<{ id: string }>;

  // 4b. run_budget rows whose run is no longer paused (cancelled out-of-band,
  //     or finished from in-flight completions while paused) expire the same
  //     way — the "raise or cancel?" question is moot (WP4).
  const expiredBudget = (await db.execute(sql`
    UPDATE pending_tool_calls p
    SET status = 'expired', decided_at = now(), updated_at = now(),
        error = 'the run is no longer paused — the budget question is moot'
    WHERE p.status = 'pending'
      AND p.tool_slug = 'run_budget'
      AND (p.args->>'run_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND EXISTS (
        SELECT 1 FROM runs r
        WHERE r.id = (p.args->>'run_id')::uuid AND r.status <> 'paused'
      )
    RETURNING p.id
  `)) as unknown as Array<{ id: string }>;

  // 4c. Decided-but-unsettled recovery (final audit F3). approve/reject
  //     flips the row BEFORE the run-side settle applies; a crash in that
  //     window strands an operator-visible decision that never took effect
  //     — for run_budget the run would sit paused forever with nothing left
  //     to approve. Revert such rows to 'pending' after a grace window so
  //     the operator simply decides again. If the crashed settle actually
  //     DID apply, re-deciding is safe: the engine CAS no-ops and the row
  //     expires with the moved-on teaching error (or duty 4/4b reaps it
  //     first). executed_at is the settle receipt — settled rows never
  //     match.
  const reverted = (await db.execute(sql`
    UPDATE pending_tool_calls p
    SET status = 'pending', decided_at = NULL, updated_at = now(),
        error = 'the decision was interrupted before it applied — please decide again'
    WHERE p.status IN ('approved', 'rejected')
      AND p.executed_at IS NULL
      AND p.tool_slug IN ('ask_human', 'run_budget')
      AND p.decided_at < now() - interval '3 minutes'
    RETURNING p.id
  `)) as unknown as Array<{ id: string }>;

  return {
    timedOut,
    redispatched: staleReady.length,
    resumesResent: unresumed.length + staleAudits.length,
    questionsExpired: expired.length + expiredBudget.length,
    settlesReverted: reverted.length,
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
