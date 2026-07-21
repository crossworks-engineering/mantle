/**
 * Operator-approved tool execution. The tool-loop enqueues rows here
 * when a `requires_confirm` tool is requested; this module owns the
 * approve/reject lifecycle and the post-approval dispatch.
 */

import { and, desc, eq } from 'drizzle-orm';
import { db, pendingToolCalls, type PendingToolCall, tools as toolsTable } from '@mantle/db';
import {
  applyBudgetDecision,
  applyHumanAnswer,
  budgetRunId,
  enqueueRunActionsSafe,
  RUN_BUDGET_TOOL_SLUG,
} from '@mantle/runs';
import { dispatchTool } from './dispatch';
import { notifyPendingChanged } from './pending-notify';
import { startTrace, step } from '@mantle/tracing';

export type PendingSummary = {
  id: string;
  toolSlug: string;
  args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  agentId: string | null;
  traceId: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
};

function toSummary(row: PendingToolCall): PendingSummary {
  return {
    id: row.id,
    toolSlug: row.toolSlug,
    args: (row.args ?? {}) as Record<string, unknown>,
    status: row.status,
    agentId: row.agentId,
    traceId: row.traceId,
    result: (row.result ?? null) as Record<string, unknown> | null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
  };
}

export type ListPendingOptions = {
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
  limit?: number;
};

export async function listPendingCalls(
  ownerId: string,
  opts: ListPendingOptions = {},
): Promise<PendingSummary[]> {
  const conds = [eq(pendingToolCalls.ownerId, ownerId)];
  if (opts.status) conds.push(eq(pendingToolCalls.status, opts.status));
  const rows = await db
    .select()
    .from(pendingToolCalls)
    .where(and(...conds))
    .orderBy(desc(pendingToolCalls.createdAt))
    .limit(opts.limit ?? 100);
  return rows.map(toSummary);
}

export async function countPending(ownerId: string): Promise<number> {
  const rows = await db
    .select({ id: pendingToolCalls.id })
    .from(pendingToolCalls)
    .where(and(eq(pendingToolCalls.ownerId, ownerId), eq(pendingToolCalls.status, 'pending')));
  return rows.length;
}

export async function getPendingCall(ownerId: string, id: string): Promise<PendingSummary | null> {
  const [row] = await db
    .select()
    .from(pendingToolCalls)
    .where(and(eq(pendingToolCalls.id, id), eq(pendingToolCalls.ownerId, ownerId)))
    .limit(1);
  return row ? toSummary(row) : null;
}

/**
 * A runner-queue `ask_human` question (slice 3 WP3) — these rows are created
 * by the runs engine at promote, never by the tool loop, and their
 * "execution" is completing the run ITEM with the human's decision instead
 * of dispatching a tool. The branch runs BEFORE tool resolution: there is no
 * registered 'ask_human' tool, by design.
 */
function askHumanItemId(row: PendingToolCall): string | null {
  if (row.toolSlug !== 'ask_human') return null;
  const itemId = (row.args as Record<string, unknown> | null)?.['item_id'];
  return typeof itemId === 'string' ? itemId : null;
}

/** The decided-but-unsettled recovery (final audit F3): the row flips
 *  approved/rejected BEFORE its run-side effect applies, so a crash or db
 *  error in between would strand an operator-visible "approved" that never
 *  took effect — with no retry path (`pending_approve` refuses decided
 *  rows). On a settle error the row REVERTS to 'pending' with the error
 *  recorded, so the operator just decides again; the sweep's janitor (duty
 *  4c) does the same for the crash window. Double-application is impossible
 *  either way — the engine's completeItem/cancelRun CAS makes a re-settle
 *  of an already-applied decision a no-op that expires the row. */
async function revertToPending(rowId: string, error: string): Promise<PendingSummary | null> {
  const [reverted] = await db
    .update(pendingToolCalls)
    .set({ status: 'pending', decidedAt: null, error, updatedAt: new Date() })
    .where(eq(pendingToolCalls.id, rowId))
    .returning();
  return reverted ? toSummary(reverted) : null;
}

/** Complete the run item behind an ask_human row and record the outcome on
 *  the row. A `moved_on` answer (the item went terminal first — cancelled,
 *  timed out) flips the row to `expired` with a teaching error instead of
 *  pretending the decision took effect. */
async function settleAskHuman(
  row: PendingToolCall,
  decision: 'answered' | 'rejected',
  answer?: string,
): Promise<PendingSummary | null> {
  const itemId = askHumanItemId(row);
  if (!itemId) {
    const [errRow] = await db
      .update(pendingToolCalls)
      .set({ error: 'ask_human row has no item_id ref — cannot apply', updatedAt: new Date() })
      .where(eq(pendingToolCalls.id, row.id))
      .returning();
    return errRow ? toSummary(errRow) : null;
  }
  let res: Awaited<ReturnType<typeof applyHumanAnswer>>;
  try {
    // ownerId from the ROW (owner-scoped by the approve/reject CAS);
    // applyHumanAnswer verifies the item's run belongs to that owner (F2).
    res = await applyHumanAnswer(db, { itemId, ownerId: row.ownerId, decision, answer });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return revertToPending(
      row.id,
      `the decision did not apply (${msg}) — the question is pending again; please decide once more`,
    );
  }
  if (!res.ok) {
    const [expiredRow] = await db
      .update(pendingToolCalls)
      .set({
        status: 'expired',
        error: res.error,
        executedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(pendingToolCalls.id, row.id))
      .returning();
    return expiredRow ? toSummary(expiredRow) : null;
  }
  await enqueueRunActionsSafe(res.actions);
  const [updated] = await db
    .update(pendingToolCalls)
    .set({
      result: { item_id: itemId, item_state: res.state, ...(answer?.trim() ? { answer } : {}) },
      executedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(pendingToolCalls.id, row.id))
    .returning();
  return updated ? toSummary(updated) : null;
}

/** A runner budget pause (WP4): approve raises the budget and resumes the
 *  run; reject cancels it. The row expires with a teaching error when the
 *  run left 'paused' first. */
async function settleBudget(
  row: PendingToolCall,
  decision: 'raise' | 'cancel',
): Promise<PendingSummary | null> {
  const runId = budgetRunId((row.args ?? null) as Record<string, unknown> | null);
  if (!runId) {
    const [errRow] = await db
      .update(pendingToolCalls)
      .set({ error: 'run_budget row has no run_id ref — cannot apply', updatedAt: new Date() })
      .where(eq(pendingToolCalls.id, row.id))
      .returning();
    return errRow ? toSummary(errRow) : null;
  }
  let res: Awaited<ReturnType<typeof applyBudgetDecision>>;
  try {
    // ownerId from the ROW; applyBudgetDecision verifies run ownership (F2).
    res = await applyBudgetDecision(db, { runId, ownerId: row.ownerId, decision });
  } catch (err) {
    // Same recovery as settleAskHuman: revert so the operator can retry —
    // a stranded 'approved' on a run_budget row would leave the run paused
    // forever with nothing left to approve.
    const msg = err instanceof Error ? err.message : String(err);
    return revertToPending(
      row.id,
      `the decision did not apply (${msg}) — the budget question is pending again; please decide once more`,
    );
  }
  if (!res.ok) {
    const [expiredRow] = await db
      .update(pendingToolCalls)
      .set({ status: 'expired', error: res.error, executedAt: new Date(), updatedAt: new Date() })
      .where(eq(pendingToolCalls.id, row.id))
      .returning();
    return expiredRow ? toSummary(expiredRow) : null;
  }
  if (res.outcome === 'raised') await enqueueRunActionsSafe(res.actions);
  const [updated] = await db
    .update(pendingToolCalls)
    .set({
      result: {
        run_id: runId,
        outcome: res.outcome,
        ...(res.outcome === 'raised' ? { new_budget_micro_usd: res.newBudgetMicroUsd } : {}),
      },
      executedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(pendingToolCalls.id, row.id))
    .returning();
  return updated ? toSummary(updated) : null;
}

/**
 * Mark a pending call rejected. For ordinary tool calls: no execution, just
 * a status flip. For runner `ask_human` questions: ALSO completes the run
 * item `failed({type:'rejected'})` so the run advances (a question left
 * dangling after a rejection would wedge its group forever). For runner
 * `run_budget` pauses: cancels the run (the "or cancel" arm).
 * Returns the updated summary or null if not found / already decided.
 */
export async function rejectPendingCall(
  ownerId: string,
  id: string,
): Promise<PendingSummary | null> {
  const [row] = await db
    .update(pendingToolCalls)
    .set({
      status: 'rejected',
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(pendingToolCalls.id, id),
        eq(pendingToolCalls.ownerId, ownerId),
        eq(pendingToolCalls.status, 'pending'),
      ),
    )
    .returning();
  // Repaint the badge / any open card the moment the status flips.
  if (row) void notifyPendingChanged(ownerId);
  if (row && row.toolSlug === 'ask_human') {
    return settleAskHuman(row, 'rejected');
  }
  if (row && row.toolSlug === RUN_BUDGET_TOOL_SLUG) {
    return settleBudget(row, 'cancel');
  }
  return row ? toSummary(row) : null;
}

/**
 * Approve a pending call — flips status, dispatches the tool, persists
 * the result. Wraps the dispatch in a `manual`-kind trace so the
 * execution shows up in /traces with its inputs + output + duration.
 *
 * Runner `ask_human` questions (slice 3 WP3) branch BEFORE tool resolution:
 * approval completes the run item `done` with `opts.answer` riding the item
 * result (free-text questions; omitted = plain approval for yes/no and
 * option-pick shapes). If the run moved on first, the row expires with a
 * teaching error instead of pretending the answer took effect.
 *
 * Returns the updated summary. The row's `result` / `error` fields
 * reflect the dispatch outcome; status flips to `approved` regardless
 * of whether the tool succeeded — the operator already said yes.
 */
export async function approvePendingCall(
  ownerId: string,
  id: string,
  opts?: { answer?: string },
): Promise<PendingSummary | null> {
  // Atomic claim — only act if still pending.
  const [claimed] = await db
    .update(pendingToolCalls)
    .set({ status: 'approved', decidedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(pendingToolCalls.id, id),
        eq(pendingToolCalls.ownerId, ownerId),
        eq(pendingToolCalls.status, 'pending'),
      ),
    )
    .returning();
  if (!claimed) return null;
  // Status has flipped to 'approved' — repaint the badge now, before the
  // (possibly slow) dispatch below.
  void notifyPendingChanged(ownerId);

  // Runner question? Complete the run item instead of dispatching a tool
  // (there is no registered 'ask_human' tool, by design).
  if (claimed.toolSlug === 'ask_human') {
    return settleAskHuman(claimed, 'answered', opts?.answer);
  }
  // Runner budget pause? Raise + resume (there is no 'run_budget' tool
  // either — WP4's "raise or cancel?" surface).
  if (claimed.toolSlug === RUN_BUDGET_TOOL_SLUG) {
    return settleBudget(claimed, 'raise');
  }

  // Resolve the tool by slug (not the snapshot at queue time — the
  // operator might have edited the handler in the meantime).
  const [tool] = await db
    .select()
    .from(toolsTable)
    .where(
      and(
        eq(toolsTable.ownerId, ownerId),
        eq(toolsTable.slug, claimed.toolSlug),
        eq(toolsTable.enabled, true),
      ),
    )
    .limit(1);
  if (!tool) {
    const [errRow] = await db
      .update(pendingToolCalls)
      .set({
        error: `tool '${claimed.toolSlug}' is not registered or disabled`,
        executedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(pendingToolCalls.id, claimed.id))
      .returning();
    return errRow ? toSummary(errRow) : null;
  }

  // Execute under a fresh `manual` trace so the operator can audit the
  // run in /traces. The originating turn's trace is long closed by now.
  let outputJson: Record<string, unknown> | null = null;
  let errorText: string | null = null;
  await startTrace(
    {
      kind: 'manual',
      ownerId,
      subjectId: claimed.id,
      subjectKind: 'pending_tool_call',
      agentId: claimed.agentId,
      data: { toolSlug: claimed.toolSlug, args: claimed.args },
    },
    async () => {
      await step(
        {
          name: `tool: ${claimed.toolSlug}`,
          kind: 'compute',
          input: { slug: claimed.toolSlug, args: claimed.args },
        },
        async (handle) => {
          const res = await dispatchTool(tool, (claimed.args ?? {}) as Record<string, unknown>, {
            ownerId,
            step: {
              setMeta: (m) => handle.setMeta(m),
              setOutput: (o) => handle.setOutput(o),
              addTokens: (d) => handle.addTokens(d),
              addCost: (mu) => handle.addCost(mu),
            },
          });
          if (res.ok) {
            outputJson =
              typeof res.output === 'object' && res.output !== null
                ? (res.output as Record<string, unknown>)
                : { value: res.output };
          } else {
            errorText = res.error;
            handle.setMeta({ error: res.error });
          }
        },
      );
    },
  );

  const [updated] = await db
    .update(pendingToolCalls)
    .set({
      result: outputJson,
      error: errorText,
      executedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(pendingToolCalls.id, claimed.id))
    .returning();
  return updated ? toSummary(updated) : null;
}
