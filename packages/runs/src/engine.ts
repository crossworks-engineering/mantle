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
      .returning({ id: runs.id });
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

/**
 * Dispatcher entry: claim a ready item before executing it. Returns the row,
 * or null when the wake-up was a duplicate / the item was cancelled or swept
 * meanwhile — ack the job and exit (the §5b idempotency discipline).
 */
export async function claimItem(db: Db | Tx, itemId: string): Promise<RunItemRow | null> {
  const [row] = await db
    .update(runItems)
    .set({ state: 'running', startedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(runItems.id, itemId), eq(runItems.state, 'ready')))
    .returning();
  return row ?? null;
}

/**
 * Semantic retry (distinct from pg-boss transport retries): put a RUNNING
 * item back to `ready` for another attempt, bumping `attempt` and re-stamping
 * the deadline. Returns the dispatch action, or null when the item isn't
 * running anymore (cancelled / swept — the retry loses). Callers enforce the
 * policy (`retry_policy.maxAttempts`, never side-effecting) before calling.
 */
export async function requeueForRetry(
  db: Db,
  itemId: string,
  timeoutSeconds: number = DEFAULT_LEAF_TIMEOUT_SECONDS,
): Promise<PostCommitAction | null> {
  const [row] = await db
    .update(runItems)
    .set({
      state: 'ready',
      attempt: sql`${runItems.attempt} + 1`,
      deadlineAt: sql`now() + make_interval(secs => ${timeoutSeconds})`,
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
 *  CAS on status='running' so a cancelled run doesn't resume. */
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
    .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
    .returning({ id: runs.id });
  if (run) actions.push({ type: 'resume', runId, groupId: rootItemId });
}

// ── promote ──────────────────────────────────────────────────────────────────

/**
 * Make an item runnable. Leaves: `queued → ready` + a dispatch action (the
 * pg-boss wake-up). Groups: `queued → running`, then start their children —
 * seq promotes the first child, par promotes all. An empty group completes
 * on the spot and bubbles (degenerate plans keep the invariant).
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

  const rawTimeout = (item.payload as Record<string, unknown> | null)?.['timeout_seconds'];
  const timeoutSeconds =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(rawTimeout, 6 * 3600)
      : DEFAULT_LEAF_TIMEOUT_SECONDS;
  const [ready] = await tx
    .update(runItems)
    .set({
      state: 'ready',
      deadlineAt: sql`now() + make_interval(secs => ${timeoutSeconds})`,
      updatedAt: sql`now()`,
    })
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
 * cancelled FIRST (CAS on 'running' — so the root's completion path won't
 * emit a resume), then cancels the root and its subtree. Idempotent.
 */
export async function cancelRun(db: Db, runId: string): Promise<{ cancelled: boolean }> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .update(runs)
      .set({ status: 'cancelled', completedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
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
