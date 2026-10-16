/**
 * The named system step (F4 fix round 2, docs/actors.md "F4 fix round 2"):
 * the one door for the brain-wide bookkeeping a write does AFTER its item
 * check. The owner's rule: cascades, subtree work, re-indexing, history and
 * its pruning, budgets, export syncs and provisioning are the brain's, not
 * the caller's; run in the caller's workspace scope they see only what that
 * scope reads, and on the write role they are refused for tables no scope
 * writes. So they run here, on the system pool by the reason
 * 'brain-bookkeeping' (AS_SYSTEM_TURN_REASONS), never in the caller's scope.
 *
 * The contract every caller keeps:
 *  - the item check came first: the caller's scope read the item (and may
 *    change it, for a write), checked by the route's gate or by the
 *    library before the step;
 *  - the step never widens what the caller is told: it answers numbers,
 *    yes or no, or nothing, and a row it reads goes back to the caller only
 *    once the caller's scope reads that row too (the library re-reads it
 *    there);
 *  - the step is never a route a member could not reach before: it follows
 *    a write the caller was allowed to make.
 *
 * Each step names what it does (SystemStep), so a grep for systemStep( lists
 * every site with its why. docs/actors.md lists them.
 */
import { asSystem } from './viewer';

/** What a named system step does (docs/actors.md, "F4 fix round 2"). */
export type SystemStep =
  /** A table commit's history line pruned (keep and size limits), after the
   *  commit, which recorded its own row with edit of the table. */
  | 'table-history'
  /** An email attachment's bytes from object storage, for a caller whose
   *  scope holds Admin and read the file node first. */
  | 'attachment-bytes'
  /** A file's derived items and the drawings that place it: counted, and
   *  the confirmed cascade's reap, after the file's manage check. */
  | 'derived-items'
  /** The files whose effective indexing a flag change or a move changed,
   *  their index reset and queued again, hidden files included (a file
   *  turned name only must shed its content index wherever it is read). */
  | 'reindex'
  /** An app's linked Table exports marked dirty and synced, after a write
   *  to the app's data the caller was allowed to make. */
  | 'export-sync';

/**
 * Run `fn` as the named system step `step`: on the system pool, outside the
 * caller's scope, after the caller's item check (see the contract above).
 * Outside a scope (system work) it changes nothing but the actor's name.
 */
export function systemStep<T>(step: SystemStep, fn: () => Promise<T>): Promise<T> {
  void step;
  return asSystem(fn, 'brain-bookkeeping');
}
