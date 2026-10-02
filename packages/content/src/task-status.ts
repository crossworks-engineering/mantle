/**
 * The task lifecycle vocabulary, with no database import, so the item tree's
 * row metadata (tree/kinds.ts) can share it with tasks.ts.
 */
import type { TaskStatus } from '@mantle/client-types';

// `satisfies` pins this const to the wire union in @mantle/client-types, so
// adding a status here without updating the contract is a compile error.
export const TASK_STATUSES = [
  'open',
  'in_progress',
  'blocked',
  'done',
] as const satisfies readonly TaskStatus[];

/** The status a done task returns to on reopen: the one it had before it was
 *  marked done (`data.status_before_done`), or null when the brain never saw
 *  it (created done, or done before the brain started recording). Only a
 *  not-done status counts. */
export function statusBeforeDoneOf(data: Record<string, unknown>): TaskStatus | null {
  const v = data.status_before_done;
  return typeof v === 'string' && v !== 'done' && (TASK_STATUSES as readonly string[]).includes(v)
    ? (v as TaskStatus)
    : null;
}
