/**
 * Budget-pause resolution (slice 3 WP4). When `completeItem` crosses a run's
 * `budget_micro_usd` it CASes the run `running → paused` and queues a
 * `run_budget` pending row ("raise or cancel?"). This module is the answer
 * path — the run_budget twin of human.ts:
 *
 *   raise  — budget += one original budget's headroom, `paused → running`
 *            (CAS), READY audit/ask_human deadlines shift by the paused
 *            duration (nothing was executing — running items keep their
 *            clocks, amendment 3), and the run's ready work is re-emitted
 *            inline (dispatches for dispatchable kinds, resumes for
 *            unclaimed audits) — sweep-duty-2/2b's queries, run once.
 *   cancel — `cancelRun` (accepts paused, amendment 2); the janitor expires
 *            whatever the cancellation orphans.
 *
 * Owner scoping is the caller's duty (the pending row is owner-scoped by
 * approve/reject — the run_audit precedent).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { runItems, runs, type Db } from '@mantle/db';

import { cancelRun, type PostCommitAction } from './engine';
import { RUN_TOOL_QUEUE, RUN_WORKER_QUEUE } from './queues';

export type BudgetDecisionResult =
  | { ok: true; outcome: 'raised'; newBudgetMicroUsd: number; actions: PostCommitAction[] }
  | { ok: true; outcome: 'cancelled' }
  | {
      ok: false;
      /** The run is no longer paused (finished, cancelled, or already
       *  raised) — the caller expires the pending row. */
      reason: 'not_paused';
      error: string;
    };

export async function applyBudgetDecision(
  db: Db,
  opts: { runId: string; decision: 'raise' | 'cancel' },
): Promise<BudgetDecisionResult> {
  if (opts.decision === 'cancel') {
    const { cancelled } = await cancelRun(db, opts.runId);
    if (!cancelled) {
      return {
        ok: false,
        reason: 'not_paused',
        error: `run ${opts.runId} is no longer cancellable — it already finished or was cancelled`,
      };
    }
    return { ok: true, outcome: 'cancelled' };
  }

  return db.transaction(async (tx) => {
    // Run row first (the lock-ordering rule) — this transaction touches the
    // run AND its items.
    const [run] = await tx
      .select({
        status: runs.status,
        budget: runs.budgetMicroUsd,
        spent: runs.spentMicroUsd,
        pausedAt: runs.pausedAt,
      })
      .from(runs)
      .where(eq(runs.id, opts.runId))
      .for('update');
    if (!run || run.status !== 'paused') {
      return {
        ok: false,
        reason: 'not_paused' as const,
        error: `run ${opts.runId} is not paused (${run?.status ?? 'missing'}) — nothing to raise`,
      };
    }

    // Headroom = one more original budget on top of what was actually spent
    // (deterministic: N raises grant N extra budgets; no free-text parsing).
    const original = run.budget ?? 0;
    const newBudget = run.spent + original;
    const [resumed] = await tx
      .update(runs)
      .set({
        status: 'running',
        budgetMicroUsd: newBudget,
        pausedAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(runs.id, opts.runId), eq(runs.status, 'paused')))
      .returning({ id: runs.id });
    if (!resumed) {
      return {
        ok: false,
        reason: 'not_paused' as const,
        error: `run ${opts.runId} left 'paused' concurrently — decision not applied`,
      };
    }

    // Shift READY verdict/question deadlines by the paused duration —
    // nothing was executing, so the pause must not eat their windows.
    // Running items deliberately keep their clocks (they never stopped).
    if (run.pausedAt) {
      await tx
        .update(runItems)
        .set({
          deadlineAt: sql`${runItems.deadlineAt} + (now() - ${run.pausedAt.toISOString()}::timestamptz)`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(runItems.runId, opts.runId),
            eq(runItems.state, 'ready'),
            inArray(runItems.kind, ['audit', 'ask_human']),
            sql`${runItems.deadlineAt} is not null`,
          ),
        );
    }

    // Re-emit the run's parked work (post-commit, as always): dispatches for
    // ready dispatchable items, resumes for ready-unclaimed audits. The
    // claims that refused during the pause now succeed.
    const actions: PostCommitAction[] = [];
    const ready = await tx
      .select({
        id: runItems.id,
        kind: runItems.kind,
        sideEffecting: runItems.sideEffecting,
        resumedAt: runItems.resumedAt,
      })
      .from(runItems)
      .where(and(eq(runItems.runId, opts.runId), eq(runItems.state, 'ready')));
    for (const item of ready) {
      if (item.kind === 'ask_human') continue; // human-driven — still parked, on purpose
      if (item.kind === 'audit') {
        if (!item.resumedAt) actions.push({ type: 'resume', runId: opts.runId, groupId: item.id });
        continue;
      }
      actions.push({
        type: 'dispatch',
        queue: item.kind === 'worker_invoke' ? RUN_WORKER_QUEUE : RUN_TOOL_QUEUE,
        itemId: item.id,
        sideEffecting: item.sideEffecting,
      });
    }
    return { ok: true, outcome: 'raised' as const, newBudgetMicroUsd: newBudget, actions };
  });
}

/** Re-exported for the pending-row branch: is a row a run_budget question? */
export function budgetRunId(args: Record<string, unknown> | null): string | null {
  const runId = args?.['run_id'];
  return typeof runId === 'string' ? runId : null;
}

export const RUN_BUDGET_TOOL_SLUG = 'run_budget';
