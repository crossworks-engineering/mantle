/**
 * Runner-queue execution engine — slice 1, "the spine".
 *
 * The run is a tree of `run_items` (structured concurrency: `group_seq` /
 * `group_par` interior nodes, leaves execute). This module owns every state
 * transition; nothing else writes `run_items.state`.
 *
 * ── The resume-storm solution (DECIDED 2026-07-21) ──────────────────────────
 * Every child terminal transition increments its parent group's
 * `children_done` under the parent's ROW LOCK (plain `UPDATE … SET
 * children_done = children_done + 1 … RETURNING`). Concurrent completions
 * serialize on that lock, so exactly ONE transaction observes
 * `children_done == children_total`, transitions the group terminal (sealing
 * it), and bubbles the same way into the grandparent. When the completing
 * group is the run's root (slice 2 adds: or contains an `audit` item), the
 * finishing transaction emits a RESUME action. Invariant: every group
 * completes exactly once; every completion produces at most one resume.
 *
 * ── Side effects are post-commit actions ────────────────────────────────────
 * Engine functions run inside one transaction and RETURN `PostCommitAction[]`
 * (pg-boss enqueues) instead of enqueuing directly. The caller executes them
 * after commit — pg-boss must never observe uncommitted state, and a crash
 * between commit and enqueue is healed by the sweep (ready items with no live
 * job get re-enqueued; a completed run whose resume was lost is re-sent).
 * pg-boss `singletonKey` backstops any double-send. The table is the truth;
 * jobs are disposable wake-ups.
 *
 * ── Idempotency discipline ──────────────────────────────────────────────────
 * Every transition is a CAS (`UPDATE … WHERE state IN (…) RETURNING`); a
 * duplicate or stale wake-up finds no row and no-ops. At-least-once delivery
 * becomes effectively-once semantics.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  pendingToolCalls,
  runItems,
  runs,
  type Db,
  type RunItemFailure,
  type RunItemKind,
  type RunItemRow,
  type RunItemState,
} from '@mantle/db';

import { RUN_TOOL_QUEUE, RUN_WORKER_QUEUE } from './queues';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * LOCK ORDERING RULE (audit 2026-07-21): every transaction that takes MORE
 * THAN ONE run_items/runs row lock in a run must acquire the RUN row lock
 * first. Without it, completion (child → parent, engine.ts) and bulk
 * cancellation (parent → subtree, `cancelSubtreeItems` via fail_fast or
 * cancelRun) lock in opposite orders and deadlock — e.g. a par child failing
 * (fail_fast cancels its running sibling) while that sibling completes.
 * Holders: `completeItem`, `appendChildren`, `claimWorkerItem` (cap check),
 * `cancelRun` (its first statement UPDATEs the runs row — same lock).
 * Single-statement CAS helpers (`claimItem`, `supersedeItem`,
 * `requeueForRetry`) take one lock and are exempt. Cost: completions within
 * one run serialize on the run row — they already serialized on the parent
 * row for the counter, so the loss is only cross-group parallelism inside a
 * single run, which is noise at run scale.
 */
async function lockRunRow(tx: Tx, runId: string): Promise<void> {
  await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for('update');
}

/** pg-boss enqueues owed after the surrounding transaction commits.
 *  `sideEffecting` rides on dispatch actions so the sender can set transport
 *  `retryLimit: 0` for side-effecting items (§5b: exempt from BOTH retry
 *  layers). */
export type PostCommitAction =
  | {
      type: 'dispatch';
      queue: typeof RUN_TOOL_QUEUE | typeof RUN_WORKER_QUEUE;
      itemId: string;
      sideEffecting: boolean;
    }
  | { type: 'resume'; runId: string; groupId: string };

/** Terminal states a caller may complete an item into. ('superseded' is set
 *  by the re-planning path, not by execution.) */
export type TerminalState = 'done' | 'failed' | 'cancelled';

const TERMINAL_STATES: RunItemState[] = ['done', 'failed', 'cancelled', 'superseded'];
const NON_TERMINAL_STATES: RunItemState[] = ['queued', 'ready', 'running'];

/** Leaves get a deadline stamped when PROMOTED (not created — a queued seq
 *  step shouldn't burn its clock waiting on predecessors). Override per item
 *  with `payload.timeout_seconds`. The sweep fails overdue items with a
 *  structured timeout, which drives the completion counter like any other
 *  terminal transition. */
export const DEFAULT_LEAF_TIMEOUT_SECONDS = 600;

// ── plan input ───────────────────────────────────────────────────────────────

export type PlanLeaf = {
  kind: Exclude<RunItemKind, 'group_seq' | 'group_par'>;
  /** `timeout_seconds` (number) is read at promotion to stamp the deadline. */
  payload: Record<string, unknown>;
  sideEffecting?: boolean;
  retryPolicy?: { maxAttempts?: number };
  /** Executing agent (worker_invoke) — soft ref. */
  agentId?: string;
};

export type PlanGroup = {
  kind: 'seq' | 'par';
  joinPolicy?: 'wait_all' | 'fail_fast';
  /** Display label for the run view / compiled state (stored on payload). */
  label?: string;
  deadlineAt?: Date;
  children: PlanNode[];
};

export type PlanNode = PlanGroup | PlanLeaf;

function isGroup(node: PlanNode): node is PlanGroup {
  return node.kind === 'seq' || node.kind === 'par';
}

export class SealedGroupError extends Error {
  constructor(groupId: string) {
    super(`run group ${groupId} is sealed — append to a new group instead`);
    this.name = 'SealedGroupError';
  }
}

/** WP4: the runaway-append backstop. Thrown by createRun/appendChildren when
 *  a plan would push the run past `runs.item_cap`; tool handlers turn it
 *  into a teaching error. */
export class ItemCapError extends Error {
  constructor(cap: number, wouldBe: number) {
    super(
      `this would put the run at ${wouldBe} items — over its cap of ${cap}. ` +
        `Split the work into a separate run (run_plan), or plan fewer, larger steps.`,
    );
    this.name = 'ItemCapError';
  }
}

/** Count every node (groups included) a plan subtree would insert. */
function countPlanNodes(node: PlanNode): number {
  return isGroup(node) ? 1 + node.children.reduce((n, c) => n + countPlanNodes(c), 0) : 1;
}

// ── create ───────────────────────────────────────────────────────────────────

/**
 * Create a run from a plan tree and start it: the root group goes `running`,
 * its first (seq) or all (par) children are promoted, ready leaves become
 * dispatch actions. An empty root completes the run immediately (with the
 * resume action to match — the invariant holds even for degenerate plans).
 */
export async function createRun(
  db: Db,
  opts: {
    ownerId: string;
    agentId?: string;
    originTurnId?: string;
    title: string;
    plan: PlanGroup;
    budgetMicroUsd?: number;
    itemCap?: number;
  },
): Promise<{ runId: string; rootItemId: string; actions: PostCommitAction[] }> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(runs)
      .values({
        ownerId: opts.ownerId,
        agentId: opts.agentId,
        originTurnId: opts.originTurnId,
        title: opts.title,
        budgetMicroUsd: opts.budgetMicroUsd,
        ...(opts.itemCap !== undefined ? { itemCap: opts.itemCap } : {}),
      })
      .returning({ id: runs.id, itemCap: runs.itemCap });
    // WP4: the runaway backstop, enforced at birth — a plan bigger than the
    // cap refuses with a teaching error (transaction rolls back, no run).
    const planSize = countPlanNodes(opts.plan);
    if (planSize > run!.itemCap) throw new ItemCapError(run!.itemCap, planSize);
    const rootId = await insertNode(tx, run!.id, null, 0, opts.plan);
    await tx.update(runs).set({ rootItemId: rootId }).where(eq(runs.id, run!.id));

    const actions: PostCommitAction[] = [];
    const [root] = await tx.select().from(runItems).where(eq(runItems.id, rootId));
    await promote(tx, root!, actions);
    return { runId: run!.id, rootItemId: rootId, actions };
  });
}

/** Recursively insert a plan subtree; children get `position` 0..n-1 and
 *  groups record `children_total` up front. Everything starts `queued`. */
async function insertNode(
  tx: Tx,
  runId: string,
  parentId: string | null,
  position: number,
  node: PlanNode,
): Promise<string> {
  if (isGroup(node)) {
    const [row] = await tx
      .insert(runItems)
      .values({
        runId,
        parentId,
        position,
        kind: node.kind === 'seq' ? 'group_seq' : 'group_par',
        joinPolicy: node.joinPolicy ?? 'wait_all',
        childrenTotal: node.children.length,
        deadlineAt: node.deadlineAt,
        ...(node.label ? { payload: { label: node.label } } : {}),
      })
      .returning({ id: runItems.id });
    for (let i = 0; i < node.children.length; i++) {
      await insertNode(tx, runId, row!.id, i, node.children[i]!);
    }
    return row!.id;
  }
  const [row] = await tx
    .insert(runItems)
    .values({
      runId,
      parentId,
      position,
      kind: node.kind,
      payload: node.payload,
      sideEffecting: node.sideEffecting ?? false,
      retryPolicy: node.retryPolicy,
      agentId: node.agentId,
    })
    .returning({ id: runItems.id });
  return row!.id;
}

// ── dispatch handshake ───────────────────────────────────────────────────────

/** Execution budget for a leaf, from its payload. Stamped as the deadline at
 *  CLAIM time (running = the clock; a ready item waiting on the queue or the
 *  worker cap burns nothing — the sweep's lost-job heal covers ready limbo). */
function leafTimeoutSeconds(payload: unknown): number {
  const raw = (payload as Record<string, unknown> | null)?.['timeout_seconds'];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(raw, 6 * 3600)
    : DEFAULT_LEAF_TIMEOUT_SECONDS;
}

/**
 * Dispatcher entry: claim a ready item before executing it. Returns the row,
 * or null when the wake-up was a duplicate / the item was cancelled or swept
 * meanwhile — ack the job and exit (the §5b idempotency discipline).
 */
export async function claimItem(db: Db | Tx, itemId: string): Promise<RunItemRow | null> {
  const [pre] = await db
    .select({ payload: runItems.payload })
    .from(runItems)
    .where(eq(runItems.id, itemId));
  const timeout = leafTimeoutSeconds(pre?.payload ?? null);
  const [row] = await db
    .update(runItems)
    .set({
      state: 'running',
      startedAt: sql`now()`,
      deadlineAt: sql`now() + make_interval(secs => ${timeout})`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(runItems.id, itemId),
        eq(runItems.state, 'ready'),
        // WP4: pause gates NEW WORK at the claim, never at promote (a
        // refused promotion would leave a queued child nothing re-promotes
        // — the wedge the audit's amendment 1 exists to prevent). A paused
        // run's ready items stay ready; resume re-dispatches them.
        sql`exists (select 1 from ${runs} r where r.id = ${runItems.runId} and r.status = 'running')`,
      ),
    )
    .returning();
  return row ?? null;
}

/** Per-run worker concurrency cap (plan §5): how many `worker_invoke` items
 *  may be `running` at once. Protects small boxes from a wide par group. */
export function workerConcurrencyCap(): number {
  const raw = Number(process.env.MANTLE_RUNS_WORKER_CONCURRENCY ?? '');
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
}

/**
 * Claim a `worker_invoke` item under the per-run cap. The run row's lock
 * serializes cap decisions, so two concurrent claims can't both squeeze into
 * the last slot. Returns:
 *   { item }          — claimed; execute it.
 *   { capped: true }  — slots full; ack the job. A slot-release re-dispatch
 *                       (on any worker completion) or the sweep re-wakes it.
 *   { item: null }    — stale/duplicate wake-up; ack.
 */
export async function claimWorkerItem(
  db: Db,
  itemId: string,
  cap: number = workerConcurrencyCap(),
): Promise<{ item: RunItemRow | null; capped?: boolean }> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: runItems.id, runId: runItems.runId, state: runItems.state })
      .from(runItems)
      .where(and(eq(runItems.id, itemId), eq(runItems.kind, 'worker_invoke')));
    if (!target || target.state !== 'ready') return { item: null };
    // Serialize per-run cap decisions on the run row.
    const [run] = await tx
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(eq(runs.id, target.runId))
      .for('update');
    // WP4: a paused run claims nothing (not `capped` — no re-wake wanted;
    // resume re-dispatches its ready items).
    if (!run || run.status !== 'running') return { item: null };
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(runItems)
      .where(
        and(
          eq(runItems.runId, target.runId),
          eq(runItems.kind, 'worker_invoke'),
          eq(runItems.state, 'running'),
        ),
      )) as [{ n: number }];
    if (n >= cap) return { item: null, capped: true };
    const claimed = await claimItem(tx, itemId);
    return { item: claimed };
  });
}

/**
 * Relabel a TERMINAL item as superseded (the redo path: the replacement is
 * already appended). Both states are terminal, so the parent counter is
 * untouched — the item already drove it when it first completed. CAS-guarded;
 * returns false if the item wasn't in a supersedable state.
 */
export async function supersedeItem(
  db: Db | Tx,
  itemId: string,
  supersededBy: string,
): Promise<boolean> {
  const [row] = await db
    .update(runItems)
    .set({ state: 'superseded', supersededBy, updatedAt: sql`now()` })
    .where(and(eq(runItems.id, itemId), inArray(runItems.state, ['done', 'failed'])))
    .returning({ id: runItems.id });
  return !!row;
}

/**
 * Semantic retry (distinct from pg-boss transport retries): put a RUNNING
 * item back to `ready` for another attempt, bumping `attempt`. The deadline
 * clears — ready items have NULL deadlines by contract (execution budget
 * stamps at CLAIM; ready limbo is the sweep's lost-job territory). Returns
 * the dispatch action, or null when the item isn't running anymore
 * (cancelled / swept — the retry loses). Callers enforce the policy
 * (`retry_policy.maxAttempts`, never side-effecting) before calling.
 */
export async function requeueForRetry(db: Db, itemId: string): Promise<PostCommitAction | null> {
  const [row] = await db
    .update(runItems)
    .set({
      state: 'ready',
      attempt: sql`${runItems.attempt} + 1`,
      deadlineAt: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(runItems.id, itemId), eq(runItems.state, 'running')))
    .returning({ id: runItems.id, kind: runItems.kind, sideEffecting: runItems.sideEffecting });
  if (!row) return null;
  return {
    type: 'dispatch',
    queue: row.kind === 'worker_invoke' ? RUN_WORKER_QUEUE : RUN_TOOL_QUEUE,
    itemId: row.id,
    sideEffecting: row.sideEffecting,
  };
}

// ── complete ─────────────────────────────────────────────────────────────────

/**
 * Drive an item to a terminal state and bubble completion up the tree. The
 * heart of the engine — call it from the dispatcher (item finished), the
 * sweep (`failed` with a timeout failure record), or cancellation.
 *
 * Returns `completed: false` when the item was already terminal (duplicate
 * delivery, or a sweep racing the real completion) — a no-op, counters
 * untouched.
 */
export async function completeItem(
  db: Db,
  opts: {
    itemId: string;
    state: TerminalState;
    result?: Record<string, unknown>;
    failure?: RunItemFailure;
    usage?: Record<string, number>;
    costMicroUsd?: number;
    traceRef?: string;
  },
): Promise<{ completed: boolean; actions: PostCommitAction[] }> {
  return db.transaction(async (tx) => {
    // Lock-ordering rule: run row FIRST (see lockRunRow). The pre-read is
    // un-locked and may be stale; the CAS below stays the correctness gate.
    const [pre] = await tx
      .select({ runId: runItems.runId })
      .from(runItems)
      .where(eq(runItems.id, opts.itemId));
    if (!pre) return { completed: false, actions: [] };
    await lockRunRow(tx, pre.runId);

    const result =
      opts.result || opts.failure
        ? { ...(opts.result ?? {}), ...(opts.failure ? { failure: opts.failure } : {}) }
        : undefined;
    const [item] = await tx
      .update(runItems)
      .set({
        state: opts.state,
        ...(result !== undefined ? { result } : {}),
        ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
        ...(opts.costMicroUsd !== undefined ? { costMicroUsd: opts.costMicroUsd } : {}),
        ...(opts.traceRef !== undefined ? { traceRef: opts.traceRef } : {}),
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(runItems.id, opts.itemId), inArray(runItems.state, NON_TERMINAL_STATES)))
      .returning();
    if (!item) return { completed: false, actions: [] };

    const actions: PostCommitAction[] = [];
    await onTerminal(tx, item, opts.state, actions);

    // WP4: cost honesty + budget enforcement, under the run lock already
    // held (C5 — race-free; increment only because the item CAS above
    // returned a row). Ordered AFTER onTerminal (amendment 2): if this very
    // completion finished the root, the run left 'running' in this
    // transaction and the pause CAS below no-ops — a finished run is never
    // paused.
    if (typeof opts.costMicroUsd === 'number' && opts.costMicroUsd > 0) {
      const [r] = await tx
        .update(runs)
        .set({
          spentMicroUsd: sql`${runs.spentMicroUsd} + ${opts.costMicroUsd}`,
          updatedAt: sql`now()`,
        })
        .where(eq(runs.id, pre.runId))
        .returning({
          status: runs.status,
          budget: runs.budgetMicroUsd,
          spent: runs.spentMicroUsd,
          title: runs.title,
          ownerId: runs.ownerId,
        });
      if (r && r.status === 'running' && r.budget !== null && r.spent > r.budget) {
        const [paused] = await tx
          .update(runs)
          .set({ status: 'paused', pausedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(eq(runs.id, pre.runId), eq(runs.status, 'running')))
          .returning({ id: runs.id });
        if (paused) {
          // The "raise or cancel?" surface — same pending-approvals queue as
          // ask_human. agent_id NULL for the same FK reason (see promote).
          await tx.insert(pendingToolCalls).values({
            ownerId: r.ownerId,
            toolSlug: 'run_budget',
            args: {
              question:
                `Run "${r.title}" has spent $${(r.spent / 1e6).toFixed(2)} of its ` +
                `$${(r.budget / 1e6).toFixed(2)} budget and is PAUSED. Approve to raise ` +
                `the budget by another $${(r.budget / 1e6).toFixed(2)} and resume; reject to cancel the run.`,
              run_id: pre.runId,
              budget_micro_usd: r.budget,
              spent_micro_usd: r.spent,
            },
          });
        }
      }
    }

    // Slot release (plan §5): a worker finishing frees a cap slot — wake the
    // cap-waiting `ready` worker items in this run. Duplicates are harmless
    // (claimWorkerItem re-checks the cap); the sweep is the slow-path backup.
    if (item.kind === 'worker_invoke') {
      const waiting = await tx
        .select({ id: runItems.id, sideEffecting: runItems.sideEffecting })
        .from(runItems)
        .where(
          and(
            eq(runItems.runId, item.runId),
            eq(runItems.kind, 'worker_invoke'),
            eq(runItems.state, 'ready'),
          ),
        )
        .limit(workerConcurrencyCap());
      for (const w of waiting) {
        actions.push({
          type: 'dispatch',
          queue: RUN_WORKER_QUEUE,
          itemId: w.id,
          sideEffecting: w.sideEffecting,
        });
      }
    }
    return { completed: true, actions };
  });
}

/**
 * An item just reached a terminal state inside this transaction — bubble.
 * Root (no parent): finalize the run. Otherwise: the atomic counter increment
 * on the parent, seq promotion / fail_fast sibling cancellation, and group
 * completion when this was the last child (which recurses right back here for
 * the parent).
 */
async function onTerminal(
  tx: Tx,
  item: Pick<RunItemRow, 'id' | 'runId' | 'parentId' | 'position'>,
  state: TerminalState | 'superseded',
  actions: PostCommitAction[],
): Promise<void> {
  if (!item.parentId) {
    await finalizeRun(tx, item.runId, item.id, state, actions);
    return;
  }

  // THE atomic increment — the parent's row lock serializes every concurrent
  // child completion; exactly one transaction sees done == total below.
  const [group] = await tx
    .update(runItems)
    .set({ childrenDone: sql`${runItems.childrenDone} + 1`, updatedAt: sql`now()` })
    .where(eq(runItems.id, item.parentId))
    .returning();
  if (!group) return; // parent deleted under us (run teardown) — nothing to do

  const failed = state === 'failed';
  let done = group.childrenDone; // post-increment value
  const total = group.childrenTotal;

  if (failed && group.joinPolicy === 'fail_fast' && done < total) {
    // First failure cancels the pending siblings. We hold the group's row
    // lock, so counting is race-free. Cancelled subtrees don't drive their
    // own (dead) counters — only the top-level siblings count here.
    done = await cancelPendingChildren(tx, group.id, done);
  } else if (group.kind === 'group_seq' && done < total) {
    // Advance the chain: promote the next queued child, if any.
    const [next] = await tx
      .select()
      .from(runItems)
      .where(and(eq(runItems.parentId, group.id), eq(runItems.state, 'queued')))
      .orderBy(asc(runItems.position))
      .limit(1);
    if (next) await promote(tx, next, actions);
  }

  if (done === total && group.state === 'running') {
    await completeGroup(tx, group, actions);
  }
}

/** Cancel every non-terminal child of `groupId` (subtrees included, without
 *  driving their internal counters — those groups die with their subtree) and
 *  credit the parent's counter for each direct child cancelled. Returns the
 *  parent's post-credit `children_done`. */
async function cancelPendingChildren(tx: Tx, groupId: string, doneBefore: number): Promise<number> {
  const cancelled = await cancelSubtreeItems(tx, groupId);
  if (cancelled === 0) return doneBefore;
  const [g] = await tx
    .update(runItems)
    .set({ childrenDone: sql`${runItems.childrenDone} + ${cancelled}`, updatedAt: sql`now()` })
    .where(eq(runItems.id, groupId))
    .returning({ childrenDone: runItems.childrenDone });
  return g!.childrenDone;
}

/** Mark every non-terminal item strictly BELOW `rootId` cancelled; returns
 *  how many DIRECT children of `rootId` were cancelled. In-flight handlers on
 *  cancelled items no-op at their CAS. */
async function cancelSubtreeItems(tx: Tx, rootId: string): Promise<number> {
  const res = await tx.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, parent_id FROM run_items WHERE parent_id = ${rootId}
      UNION ALL
      SELECT ri.id, ri.parent_id FROM run_items ri JOIN subtree s ON ri.parent_id = s.id
    )
    UPDATE run_items SET state = 'cancelled', finished_at = now(), updated_at = now()
    WHERE id IN (SELECT id FROM subtree)
      AND state IN ('queued', 'ready', 'running')
    RETURNING parent_id
  `);
  const rows = res as unknown as Array<{ parent_id: string }>;
  return rows.filter((r) => r.parent_id === rootId).length;
}

/**
 * All children accounted for — transition the group terminal and SEAL it
 * (late `run_append` now errors; caller starts a new group), then bubble into
 * the grandparent. wait_all semantics: the group waited for everything, its
 * terminal state summarizes — 'failed' if any child failed, 'cancelled' if
 * nothing succeeded and something was cancelled, else 'done'.
 */
async function completeGroup(
  tx: Tx,
  group: RunItemRow,
  actions: PostCommitAction[],
): Promise<void> {
  const counts = await tx
    .select({ state: runItems.state, n: sql<number>`count(*)::int` })
    .from(runItems)
    .where(eq(runItems.parentId, group.id))
    .groupBy(runItems.state);
  const byState = Object.fromEntries(counts.map((c) => [c.state, c.n]));
  const nFailed = byState['failed'] ?? 0;
  const nCancelled = byState['cancelled'] ?? 0;
  const nDone = byState['done'] ?? 0;
  const terminal: TerminalState =
    nFailed > 0
      ? 'failed'
      : nCancelled > 0 && nDone === 0 && group.childrenTotal > 0
        ? 'cancelled'
        : 'done';

  const [sealed] = await tx
    .update(runItems)
    .set({
      state: terminal,
      sealed: true,
      result: { summary: { done: nDone, failed: nFailed, cancelled: nCancelled } },
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(runItems.id, group.id), eq(runItems.state, 'running')))
    .returning();
  if (!sealed) return; // someone else completed it — impossible under the row lock, but CAS anyway

  // Slice 2: a non-root group containing an `audit` item also emits a resume
  // (responder attention). Slice 1: only the root resumes.
  await onTerminal(tx, sealed, terminal, actions);
}

/** The root reached a terminal state — close the run and wake the responder.
 *  CAS on status IN ('running','paused') so a cancelled run doesn't resume —
 *  but a PAUSED run whose in-flight items drove the counter to completion
 *  finalizes normally (WP4 amendment 2: a run must never sit paused with a
 *  sealed root and no resume). */
async function finalizeRun(
  tx: Tx,
  runId: string,
  rootItemId: string,
  state: TerminalState | 'superseded',
  actions: PostCommitAction[],
): Promise<void> {
  const status = state === 'done' ? 'done' : state === 'superseded' ? 'cancelled' : state;
  const [run] = await tx
    .update(runs)
    .set({ status, completedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(runs.id, runId), inArray(runs.status, ['running', 'paused'])))
    .returning({ id: runs.id });
  if (run) actions.push({ type: 'resume', runId, groupId: rootItemId });
}

// ── promote ──────────────────────────────────────────────────────────────────

/** Audit items must reach a verdict within this window or the sweep fails
 *  them (the run must never wedge on a lost/crashed audit turn). Overridable
 *  per item via `payload.timeout_seconds`. */
export const DEFAULT_AUDIT_TIMEOUT_SECONDS = 1800;

/**
 * Make an item runnable.
 * - Groups: `queued → running`, then start their children — seq promotes the
 *   first child, par promotes all. An empty group completes on the spot and
 *   bubbles (degenerate plans keep the invariant).
 * - `audit` leaves: `queued → ready` + a RESUME action — audits are judged by
 *   the responder in a resume turn (plan §7), never dispatched to a tool
 *   queue. The deadline stamps NOW (verdict budget), since audits are never
 *   claimed.
 * - Other leaves: `queued → ready` + a dispatch action (the pg-boss wake-up).
 *   Their deadline stamps at CLAIM (execution budget) — ready limbo is the
 *   sweep's lost-job territory, not a timeout.
 */
async function promote(tx: Tx, item: RunItemRow, actions: PostCommitAction[]): Promise<void> {
  if (item.kind === 'group_seq' || item.kind === 'group_par') {
    const [started] = await tx
      .update(runItems)
      .set({ state: 'running', startedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(runItems.id, item.id), eq(runItems.state, 'queued')))
      .returning();
    if (!started) return;
    if (started.childrenTotal === 0) {
      await completeGroup(tx, started, actions);
      return;
    }
    const children = await tx
      .select()
      .from(runItems)
      .where(and(eq(runItems.parentId, item.id), eq(runItems.state, 'queued')))
      .orderBy(asc(runItems.position));
    const toStart = item.kind === 'group_seq' ? children.slice(0, 1) : children;
    for (const child of toStart) await promote(tx, child, actions);
    return;
  }

  if (item.kind === 'audit') {
    const raw = (item.payload as Record<string, unknown> | null)?.['timeout_seconds'];
    const timeout =
      typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.min(raw, 6 * 3600)
        : DEFAULT_AUDIT_TIMEOUT_SECONDS;
    const [ready] = await tx
      .update(runItems)
      .set({
        state: 'ready',
        deadlineAt: sql`now() + make_interval(secs => ${timeout})`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(runItems.id, item.id), eq(runItems.state, 'queued')))
      .returning({ id: runItems.id, runId: runItems.runId });
    if (!ready) return;
    actions.push({ type: 'resume', runId: ready.runId, groupId: ready.id });
    return;
  }

  if (item.kind === 'ask_human') {
    // The audit-item pattern with a human in the LLM's place (slice 3 WP3):
    // `queued → ready`, NEVER dispatched — the item sits until the answer
    // path (`applyHumanAnswer`) completes it. Deadline ONLY when the plan
    // dated the question (`payload.timeout_seconds`, stamped NOW like an
    // audit's verdict budget — the item is never claimed); an undated
    // question waits indefinitely by design and is exempt from every sweep
    // duty. The pending_tool_calls row is the approval surface (existing
    // /pending UI + telegram flow + pending_* tools — no new UI).
    const p = (item.payload ?? {}) as Record<string, unknown>;
    const raw = p['timeout_seconds'];
    const timeout =
      typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.min(raw, 30 * 24 * 3600)
        : null;
    const [ready] = await tx
      .update(runItems)
      .set({
        state: 'ready',
        ...(timeout !== null ? { deadlineAt: sql`now() + make_interval(secs => ${timeout})` } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(runItems.id, item.id), eq(runItems.state, 'queued')))
      .returning({ id: runItems.id, runId: runItems.runId, deadlineAt: runItems.deadlineAt });
    if (!ready) return;
    const [run] = await tx
      .select({ ownerId: runs.ownerId })
      .from(runs)
      .where(eq(runs.id, ready.runId));
    // agent_id stays NULL: runs.agent_id is a SOFT ref (survives agent
    // deletion) but pending_tool_calls.agent_id is a real FK — inserting a
    // dangling id would violate it. The args carry the run ref instead.
    await tx.insert(pendingToolCalls).values({
      ownerId: run!.ownerId,
      toolSlug: 'ask_human',
      args: {
        question: typeof p.question === 'string' ? p.question : '',
        ...(Array.isArray(p.options) ? { options: p.options } : {}),
        run_id: ready.runId,
        item_id: ready.id,
      },
      ...(ready.deadlineAt ? { expiresAt: ready.deadlineAt } : {}),
    });
    return; // no action — the human is the dispatcher
  }

  const [ready] = await tx
    .update(runItems)
    .set({ state: 'ready', updatedAt: sql`now()` })
    .where(and(eq(runItems.id, item.id), eq(runItems.state, 'queued')))
    .returning({ id: runItems.id, kind: runItems.kind, sideEffecting: runItems.sideEffecting });
  if (!ready) return;
  actions.push({
    type: 'dispatch',
    queue: ready.kind === 'worker_invoke' ? RUN_WORKER_QUEUE : RUN_TOOL_QUEUE,
    itemId: ready.id,
    sideEffecting: ready.sideEffecting,
  });
}

// ── append ───────────────────────────────────────────────────────────────────

/**
 * `run_append` — add children to an OPEN group. Takes the group's row lock
 * first, so an append can never race the final completion increment: either
 * it lands while a child is still pending (total grows, group stays open) or
 * the group already sealed and this throws `SealedGroupError` (caller starts
 * a new group).
 *
 * Promotion of appended children: par groups running → promote immediately.
 * Seq groups: never — an open running seq group always has a pending earlier
 * child (if it didn't, its last completion would have sealed it), and that
 * child's completion advances the chain.
 */
export async function appendChildren(
  db: Db,
  opts: { groupId: string; children: PlanNode[] },
): Promise<{ itemIds: string[]; actions: PostCommitAction[] }> {
  if (opts.children.length === 0) return { itemIds: [], actions: [] };
  return db.transaction(async (tx) => {
    // Lock-ordering rule: run row FIRST (see lockRunRow), then the group row.
    const [ref] = await tx
      .select({ runId: runItems.runId })
      .from(runItems)
      .where(eq(runItems.id, opts.groupId));
    if (!ref) throw new Error(`run group ${opts.groupId} not found`);
    await lockRunRow(tx, ref.runId);
    const [group] = await tx
      .select()
      .from(runItems)
      .where(eq(runItems.id, opts.groupId))
      .for('update');
    if (!group) throw new Error(`run group ${opts.groupId} not found`);
    if (group.kind !== 'group_seq' && group.kind !== 'group_par') {
      throw new Error(`run item ${opts.groupId} is a ${group.kind}, not a group`);
    }
    if (group.sealed || TERMINAL_STATES.includes(group.state)) {
      throw new SealedGroupError(group.id);
    }

    // WP4: item-cap check under the run lock (append races serialize there).
    const [{ existing }] = (await tx
      .select({ existing: sql<number>`count(*)::int` })
      .from(runItems)
      .where(eq(runItems.runId, group.runId))) as [{ existing: number }];
    const adding = opts.children.reduce((n, c) => n + countPlanNodes(c), 0);
    const [capRow] = await tx
      .select({ itemCap: runs.itemCap })
      .from(runs)
      .where(eq(runs.id, group.runId));
    if (capRow && existing + adding > capRow.itemCap) {
      throw new ItemCapError(capRow.itemCap, existing + adding);
    }

    const itemIds: string[] = [];
    for (let i = 0; i < opts.children.length; i++) {
      itemIds.push(
        await insertNode(tx, group.runId, group.id, group.childrenTotal + i, opts.children[i]!),
      );
    }
    await tx
      .update(runItems)
      .set({
        childrenTotal: sql`${runItems.childrenTotal} + ${opts.children.length}`,
        updatedAt: sql`now()`,
      })
      .where(eq(runItems.id, group.id));

    const actions: PostCommitAction[] = [];
    if (group.kind === 'group_par' && group.state === 'running') {
      for (const id of itemIds) {
        const [row] = await tx.select().from(runItems).where(eq(runItems.id, id));
        await promote(tx, row!, actions);
      }
    }
    return { itemIds, actions };
  });
}

// ── cancel ───────────────────────────────────────────────────────────────────

/**
 * Cancel a whole run (the responder Stop signal maps here). Marks the run
 * cancelled FIRST (CAS on 'running' OR 'paused' — a budget-paused run must
 * stay cancellable, WP4 amendment 2; the root's completion path still won't
 * emit a resume), then cancels the root and its subtree. Idempotent. The
 * sweep's janitor expires any pending ask_human / run_budget rows the
 * cancellation orphans.
 */
export async function cancelRun(db: Db, runId: string): Promise<{ cancelled: boolean }> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .update(runs)
      .set({ status: 'cancelled', completedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(runs.id, runId), inArray(runs.status, ['running', 'paused'])))
      .returning({ rootItemId: runs.rootItemId });
    if (!run) return { cancelled: false };
    if (run.rootItemId) {
      await cancelSubtreeItems(tx, run.rootItemId);
      await tx
        .update(runItems)
        .set({ state: 'cancelled', sealed: true, finishedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(runItems.id, run.rootItemId), inArray(runItems.state, NON_TERMINAL_STATES)));
    }
    return { cancelled: true };
  });
}
