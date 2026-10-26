/**
 * The approval queue's writes: a call parked for a
 * decision, and its claim, its return to pending and its settle. Pending
 * calls are infrastructure, so they are written on the system pool
 * (systemDb: the narrow route in a turn or request scope, as
 * pending-elevated.ts decides an elevated one), never by the caller's
 * scoped write. Who may decide which row is the rule in each WHERE, which
 * the caller gives (@mantle/tools pending.ts deciderFilter), as it was when
 * a login's scoped write sent these statements to the system pool anyway.
 *
 * The narrow role holds exactly the columns written here after a park
 * (access-matrix.ts NARROW_WRITES: status, decided_at, error, executed_at,
 * result, updated_at); a park runs at the full-route spot pending-park,
 * since the narrow role makes no call (no INSERT).
 */
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { systemDb } from './client';
import { onFullSystemRoute } from './viewer';
import { pendingToolCalls, type NewPendingToolCall, type PendingToolCall } from './schema/index';

/** Park one call for a decision: the one writer of a new pending row (the
 *  turn's confirm gate, an agent's queued call, the toolsmith, the dev
 *  console). Its id, or null. */
export async function parkPendingCall(values: NewPendingToolCall): Promise<string | null> {
  const [row] = await onFullSystemRoute('pending-park', () =>
    systemDb.insert(pendingToolCalls).values(values).returning({ id: pendingToolCalls.id }),
  );
  return row?.id ?? null;
}

/**
 * Decide the call `id` of brain `ownerId` while it waits: approved (the
 * claim before it runs) or rejected. `decider`: whose calls the deciding
 * login may decide (pending.ts deciderFilter; undefined: every call of the
 * brain). `notElevated`: an approval claims no elevated call here (its
 * rule is pending-elevated.ts's). The decided row, or null (not found, not
 * the decider's, or decided meanwhile).
 */
export async function decidePendingCall(args: {
  ownerId: string;
  id: string;
  decision: 'approved' | 'rejected';
  decider: SQL | undefined;
  notElevated?: boolean;
}): Promise<PendingToolCall | null> {
  const [row] = await systemDb
    .update(pendingToolCalls)
    .set({ status: args.decision, decidedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(pendingToolCalls.id, args.id),
        eq(pendingToolCalls.ownerId, args.ownerId),
        eq(pendingToolCalls.status, 'pending'),
        args.notElevated ? isNull(pendingToolCalls.elevated) : undefined,
        args.decider,
      ),
    )
    .returning();
  return row ?? null;
}

/** A decided call back to pending with `error` (a decision that did not
 *  apply: the operator decides again). The row, or null. */
export async function revertPendingCall(
  id: string,
  error: string,
): Promise<PendingToolCall | null> {
  const [row] = await systemDb
    .update(pendingToolCalls)
    .set({ status: 'pending', decidedAt: null, error, updatedAt: new Date() })
    .where(eq(pendingToolCalls.id, id))
    .returning();
  return row ?? null;
}

/** An approved call back to pending, only while it is still approved (a
 *  claim that was not judged: it never runs). */
export async function unclaimPendingCall(id: string): Promise<void> {
  await systemDb
    .update(pendingToolCalls)
    .set({ status: 'pending', decidedAt: null, updatedAt: new Date() })
    .where(and(eq(pendingToolCalls.id, id), eq(pendingToolCalls.status, 'approved')));
}

/** What a decided call's settle records: its outcome, never who asked or
 *  what it runs. */
export type PendingSettle = {
  status?: 'expired';
  error?: string | null;
  result?: Record<string, unknown> | null;
  executedAt?: Date;
  updatedAt: Date;
};

/** Record the outcome of the decided call `id` (its result or error, or
 *  expired). The row, or null. */
export async function settlePendingCall(
  id: string,
  set: PendingSettle,
): Promise<PendingToolCall | null> {
  // Each column named (an undefined one is left as it is), so the narrow
  // write scan reads what a settle may write.
  const [row] = await systemDb
    .update(pendingToolCalls)
    .set({
      status: set.status,
      error: set.error,
      result: set.result,
      executedAt: set.executedAt,
      updatedAt: set.updatedAt,
    })
    .where(eq(pendingToolCalls.id, id))
    .returning();
  return row ?? null;
}
