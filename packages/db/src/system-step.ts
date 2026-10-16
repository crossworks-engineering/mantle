/**
 * The named system step (F4 fix rounds 2 and 3, docs/actors.md "F4 fix
 * round 2" and "F4 fix round 3"): the one door for the brain-wide
 * bookkeeping a write does AFTER its item check. The owner's rule:
 * cascades, subtree work, re-indexing, history and its pruning, budgets,
 * export syncs and provisioning are the brain's, not the caller's; run in
 * the caller's workspace scope they see only what that scope reads, and on
 * the write role they are refused for tables no scope writes. So they run
 * here, on the system pool by the reason 'brain-bookkeeping'
 * (AS_SYSTEM_TURN_REASONS), never in the caller's scope.
 *
 * The contract is code, not a comment (round 3, M2): every step names the
 * items it is about and what the caller needs of them (StepItems), and the
 * door asks that (itemWriteVerdicts) in the caller's scope BEFORE it leaves
 * it:
 *  - `{ items, need }`: every item must pass, else the step throws the edit
 *    check's refusal (editCheckRefusalError: the one mapper answers it, 404
 *    for an item the scope does not read, 403 item-workspace for one it
 *    reads but may not change) and `fn` never runs. An empty list is a
 *    fault: a step with no item says so.
 *  - `{ items, need, only: 'allowed' }`: `fn` runs with the items that pass
 *    (possibly none), for a cascade over items the caller may or may not
 *    change (a file's derived items: the ones it may not change are kept).
 *  - `{ items: 'none', why }`: a step about no item (an export sync after
 *    the app data door's own check), named with its reason.
 * `fn` gets the items that passed. Outside a workspace scope (system work)
 * every item passes.
 *
 * The step never widens what the caller is told: it answers numbers, yes or
 * no, or nothing, and a row it reads goes back to the caller only once the
 * caller's scope reads that row too (the library re-reads it there).
 *
 * Never inside an open transaction (round 3, L5): the step runs on a
 * connection of its own, which would not see the transaction's rows and
 * could wait behind its locks. It throws there (RuntimeFaultError).
 *
 * Each step names what it does (SystemStep), so a grep for systemStep( lists
 * every site with its why. docs/actors.md lists them.
 */
import { editCheckRefusalError, RuntimeFaultError } from '@mantle/std';
import { inOpenTransaction } from './client';
import { itemWriteVerdicts, type ItemNeed } from './item-rights';
import { asSystem } from './viewer';

/** What a named system step does (docs/actors.md, "F4 fix round 2"). */
export type SystemStep =
  /** A table commit's history line pruned (keep and size limits), after the
   *  commit, which recorded its own row with edit of the table. */
  | 'table-history'
  /** An email attachment's bytes from object storage, for a caller whose
   *  scope holds Admin and read the file node first. */
  | 'attachment-bytes'
  /** A file's derived items and the drawings that place it: counted, found,
   *  and the confirmed cascade's reap of the ones the caller may delete,
   *  after the file's manage check. */
  | 'derived-items'
  /** The files whose effective indexing a flag change or a move changed:
   *  their index reset (a file turned name only sheds its content index
   *  wherever it is read) and, for content indexing turned on, queued again
   *  for the files the caller reads only (round 3, M1). */
  | 'reindex'
  /** An app's linked Table exports marked dirty and synced, after a write
   *  to the app's data the caller was allowed to make. */
  | 'export-sync';

/** The items a step is about and what the caller needs of them (see the
 *  contract above). */
export type StepItems =
  | Readonly<{ items: readonly string[]; need: ItemNeed; only?: undefined }>
  | Readonly<{ items: readonly string[]; need: ItemNeed; only: 'allowed' }>
  | Readonly<{ items: 'none'; why: string }>;

/**
 * Run `fn` as the named system step `step`: the item check of `check` in
 * the caller's scope first, then `fn` on the system pool, outside the
 * caller's scope, with the items that passed (see the contract above).
 */
export async function systemStep<T>(
  step: SystemStep,
  check: StepItems,
  fn: (allowed: readonly string[]) => Promise<T>,
): Promise<T> {
  if (inOpenTransaction()) {
    throw new RuntimeFaultError(
      `system step '${step}' inside an open transaction: run it after the transaction`,
    );
  }
  let allowed: readonly string[] = [];
  if (check.items === 'none') {
    if (!check.why.trim()) {
      throw new RuntimeFaultError(`system step '${step}' about no item names why`);
    }
  } else if (check.only === 'allowed') {
    const verdicts = await itemWriteVerdicts(check.items, check.need);
    allowed = check.items.filter((id) => verdicts.get(id) === 'ok');
  } else {
    if (check.items.length === 0) {
      throw new RuntimeFaultError(
        `system step '${step}' names no item: name them, or items 'none' with why`,
      );
    }
    // One refusal for the first item that does not pass, as the edit check
    // raises it (the same 404 or 403 the item's route answers).
    const verdicts = await itemWriteVerdicts(check.items, check.need);
    for (const id of check.items) {
      const v = verdicts.get(id);
      if (v !== 'ok') throw editCheckRefusalError(v ?? 'no_read');
    }
    allowed = check.items;
  }
  return asSystem(() => fn(allowed), 'brain-bookkeeping');
}
