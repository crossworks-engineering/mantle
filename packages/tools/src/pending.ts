/**
 * Operator-approved tool execution. The tool-loop enqueues rows here
 * when a `requires_confirm` tool is requested; this module owns the
 * approve/reject lifecycle and the post-approval dispatch.
 */

import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import {
  db,
  pendingToolCalls,
  runAsActor,
  type PendingToolCall,
  tools as toolsTable,
  loginActorNow,
  claimElevatedPendingCall,
  elevatedPendingCall,
} from '@mantle/db';
import {
  applyBudgetDecision,
  applyHumanAnswer,
  budgetRunId,
  enqueueRunActionsSafe,
  RUN_BUDGET_TOOL_SLUG,
  type HumanFormAnswer,
} from '@mantle/runs';
// Via the bridge, not './dispatch' directly: builtins-pending.ts imports this
// module, and dispatch.ts imports the registry, which imports every builtin —
// closing the cycle back onto builtins-pending.ts. See dispatch-bridge.ts.
import { dispatchViaBridge as dispatchTool } from './dispatch-bridge';
import { pendingCaller } from './gate-callers';
import { deciderOf, elevatedApproval, isBrainOwner, type ElevatedRun } from './pending-approval';
import { notifyPendingChanged } from './pending-notify';
import { startTrace, step } from '@mantle/tracing';
import { errorMessage } from '@mantle/std';

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
  /** The call runs with more rights than the turn that queued it (owner
   *  decision 1a, A5 step 6d, 0287): a connector write the asking scope
   *  may not make itself. Its asker may not approve it; the owner or a
   *  login with write rights on the connector may, and it runs with their
   *  rights (pending-approval.ts). Set by the server at queue time; null
   *  for every other call. */
  elevated: { elevated: true; reason: string } | null;
  /** The turn that queued it had read text a client wrote (0287, A5 step
   *  6d fix round 1): what marked it, so an approver can tell a request
   *  they made from one a client's text led to. Null for a turn that read
   *  none. */
  clientSourced: { via: string } | null;
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
    elevated: row.elevated ?? null,
    clientSourced: row.clientSourced ?? null,
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

/** How many sub-questions a row's structured `form` asks (0 = a plain
 *  question, answerable by approval alone). Defensive: the args are JSON from
 *  a model-authored plan, so anything malformed counts as "no form". */
function formQuestionCount(row: PendingToolCall): number {
  const form = (row.args as Record<string, unknown> | null)?.['form'];
  if (!form || typeof form !== 'object' || Array.isArray(form)) return 0;
  const qs = (form as Record<string, unknown>)['questions'];
  return Array.isArray(qs) ? qs.length : 0;
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
  answers?: readonly HumanFormAnswer[],
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
  // A QUESTIONNAIRE CANNOT BE ANSWERED BY A BARE "YES". Approve/reject-only
  // surfaces (the Telegram card; `pending_approve` with no payload) would
  // otherwise complete a four-question form with the string 'approved' and
  // the run would continue having learned nothing — the exact failure the
  // gate exists to prevent. Reject still works (declining to answer is a real
  // answer, and fails the step by design). Revert rather than expire, so the
  // question stays live and answerable on a surface that can render it.
  const parts = formQuestionCount(row);
  if (decision === 'answered' && parts > 0 && !answer?.trim() && !answers?.length) {
    return revertToPending(
      row.id,
      `this question is a ${parts}-part questionnaire — a plain approval would record no ` +
        `answers and the run would continue without them. Answer it on /pending (or pass ` +
        `'answers' to pending_approve). Reject it if you don't want to answer.`,
    );
  }
  let res: Awaited<ReturnType<typeof applyHumanAnswer>>;
  try {
    // ownerId from the ROW (owner-scoped by the approve/reject CAS);
    // applyHumanAnswer verifies the item's run belongs to that owner (F2).
    res = await applyHumanAnswer(db, {
      itemId,
      ownerId: row.ownerId,
      decision,
      answer,
      ...(answers?.length ? { answers } : {}),
    });
  } catch (err) {
    const msg = errorMessage(err);
    return revertToPending(
      row.id,
      `the decision did not apply (${msg}) — the question is pending again; please decide once more`,
    );
  }
  if (!res.ok) {
    // Bad answers are a CORRECTABLE mistake, not a dead question: the item
    // was never touched, so hand the decision back with the teaching error
    // instead of expiring a row the operator can still answer properly.
    if (res.reason === 'invalid_answers') return revertToPending(row.id, res.error);
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
      result: {
        item_id: itemId,
        item_state: res.state,
        ...(answer?.trim() ? { answer } : {}),
        ...(answers?.length ? { answers } : {}),
      },
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
    const msg = errorMessage(err);
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
 * Whose pending calls the deciding login may decide (W7 integration fix 2):
 * in the scope of a login other than the brain owner (its own, or the one a
 * tool's system-pool work left), or named by the route (`decider`), only
 * the calls queued for that login (pending_tool_calls.login_id; a scope
 * with no login only those queued for none). The brain owner and a call
 * with no scope and no decider (the owner's Telegram card, system work):
 * no narrowing. Who decides: deciderOf (pending-approval.ts). An elevated
 * call is not decided by this rule but by elevatedApproval (A5 step 6d fix
 * round 1).
 */
function deciderFilter(ownerId: string, decider?: string | null): SQL | undefined {
  const login = deciderOf(ownerId, decider);
  if (login === null) return isNull(pendingToolCalls.loginId);
  if (isBrainOwner(ownerId, login)) return undefined;
  return eq(pendingToolCalls.loginId, login);
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
  /** The login rejecting it, when a route names one (deciderFilter). */
  deciderLoginId?: string,
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
        deciderFilter(ownerId, deciderLoginId),
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
  opts?: {
    answer?: string;
    answers?: readonly HumanFormAnswer[];
    /** The login approving it (its session's actor, its MCP connection's
     *  login), set by the server, never from model arguments (W6b fix round
     *  3, L-2): the call runs naming it, so the owner's own confirmed
     *  app_delete is purged after 30 days and anyone else's is held. */
    approverLoginId?: string;
  },
): Promise<PendingSummary | null> {
  // Who approves (deciderOf): the scope's login, else the one the path
  // names, else the owner. Named in the call's audit row on every path.
  const approver = deciderOf(ownerId, opts?.approverLoginId);
  // Atomic claim: only act if still pending. Every call but an elevated
  // one: by whose calls the approver decides (deciderFilter), as before.
  let [claimed] = await db
    .update(pendingToolCalls)
    .set({ status: 'approved', decidedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(pendingToolCalls.id, id),
        eq(pendingToolCalls.ownerId, ownerId),
        eq(pendingToolCalls.status, 'pending'),
        isNull(pendingToolCalls.elevated),
        deciderFilter(ownerId, opts?.approverLoginId),
      ),
    )
    .returning();
  // A call queued with more rights than its asker's scope (owner decision
  // 1a, 0287) meets the approval rule first (elevatedApproval), before it
  // is claimed, so a refused approver (its asker, or a login without write
  // rights on its connector) leaves it pending for one who may: it throws
  // ApprovalRefusedError, which every path answers as a refusal.
  let elevated: ElevatedRun | null = null;
  if (!claimed) {
    // On the system pool (pending-elevated.ts): the rule decides who reads
    // it, never the deciding scope's row rule, which shows a login only its
    // own calls and so hides an elevated call from every approver.
    const queued = await elevatedPendingCall(ownerId, id);
    if (!queued) return null;
    elevated = await elevatedApproval(
      ownerId,
      queued,
      await enabledTool(ownerId, queued.toolSlug),
      approver,
      // The context dispatch gives the gate below (its surface).
      {
        ownerId,
        surface: {
          kind: 'owner',
          via: 'pending',
          ...(opts?.approverLoginId ? { loginId: opts.approverLoginId } : {}),
        },
      },
    );
    claimed = (await claimElevatedPendingCall(ownerId, id)) ?? undefined;
  }
  if (!claimed) return null;
  // Status has flipped to 'approved' — repaint the badge now, before the
  // (possibly slow) dispatch below.
  void notifyPendingChanged(ownerId);

  // Runner question? Complete the run item instead of dispatching a tool
  // (there is no registered 'ask_human' tool, by design).
  if (claimed.toolSlug === 'ask_human') {
    return settleAskHuman(claimed, 'answered', opts?.answer, opts?.answers);
  }
  // Runner budget pause? Raise + resume (there is no 'run_budget' tool
  // either — WP4's "raise or cancel?" surface).
  if (claimed.toolSlug === RUN_BUDGET_TOOL_SLUG) {
    return settleBudget(claimed, 'raise');
  }

  // Resolve the tool by slug (not the snapshot at queue time — the
  // operator might have edited the handler in the meantime).
  const tool = await enabledTool(ownerId, claimed.toolSlug);
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

  // Arch A2a: the call runs as the login whose turn asked for it, as that
  // login is now; a row with no login keeps the caller's actor. An elevated
  // call runs with its approver's rights (A5 step 6d fix round 1): the
  // owner's, or the login whose own scope passed the connector rule.
  const callActor = elevated
    ? await loginActorNow(elevated.runAs, 'pending:approve', elevated.owner ? 'owner' : 'rw')
    : claimed.loginId
      ? await loginActorNow(claimed.loginId, 'pending:approve')
      : null;
  const asCallLogin = <T>(fn: () => Promise<T>) => (callActor ? runAsActor(callActor, fn) : fn());

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
          const res = await asCallLogin(() =>
            dispatchTool(tool, (claimed.args ?? {}) as Record<string, unknown>, {
              ownerId,
              // Through the one gate, as the approved call (A5 step 3a),
              // naming its approver (its audit row's `approver`); an
              // elevated call with the scope its connector rule reads.
              caller: elevated?.caller ?? pendingCaller({ approver }),
              // An Admin user approves a pending call, so it runs on the owner
              // surface, naming the approver when the path names one.
              surface: {
                kind: 'owner',
                via: 'pending',
                ...(opts?.approverLoginId ? { loginId: opts.approverLoginId } : {}),
              },
              step: {
                setMeta: (m) => handle.setMeta(m),
                setOutput: (o) => handle.setOutput(o),
                addTokens: (d) => handle.addTokens(d),
                addCost: (mu) => handle.addCost(mu),
              },
            }),
          );
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

/** The enabled tool row named `slug`, or null. */
async function enabledTool(ownerId: string, slug: string) {
  const [tool] = await db
    .select()
    .from(toolsTable)
    .where(
      and(eq(toolsTable.ownerId, ownerId), eq(toolsTable.slug, slug), eq(toolsTable.enabled, true)),
    )
    .limit(1);
  return tool ?? null;
}
