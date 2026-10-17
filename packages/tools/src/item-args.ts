/**
 * The items a write names (R0 fix round, M1 and L2): read from its policy's
 * `itemArgs` (tool-policy.ts ToolItemArg), the one declaration, for two
 * readers that decide nothing a call's run does not:
 *
 *  - the call audit (call-audit.ts): the row's `targets`, the items the
 *    call named (a Recall map by its node, resolved from its slug before the
 *    call runs, so a delete or a slug change still names it);
 *  - the queue-time check (gate-prerun.ts): before a call is queued for
 *    approval, one the run would refuse for its item is refused then, in
 *    the run's words, so no approver is asked about a doomed call.
 *
 * The run's own checks (the database's, and the libraries' assertItemRight)
 * decide every write; the queue-time check refuses only what they refuse
 * in every case (the argument's `least`), and is skipped where the run's
 * answer is not one answer: a list of ids (a move of several items moves
 * those it may), a Recall revision (its own lookup answers it).
 */
import { and, eq } from 'drizzle-orm';
import { db, itemWriteRefusalOf, recallMaps, recallRevisions, scopeHoldsAdmin } from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import { editCheckRefusalError, mapAccessError, UUID_RE } from '@mantle/std';
import { namedToolPolicy, type ToolItemArg } from './tool-policy';

/** The item arguments a builtin (or an owner MCP surface tool) declares. */
export function itemArgsOf(builtin: string): readonly ToolItemArg[] {
  return namedToolPolicy(builtin)?.policy.itemArgs ?? [];
}

/** The references one argument holds: a string, or a list's strings. */
function refsOf(arg: ToolItemArg, input: Record<string, unknown>): string[] {
  const v = input[arg.param];
  const all = Array.isArray(v) ? v : [v];
  return all
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim());
}

/** A node id as the item checks match it, or null when it is not one. */
function nodeId(ref: string): string | null {
  const id = ref.toLowerCase();
  return UUID_RE.test(id) ? id : null;
}

/** Whether an argument names its item by something the database resolves. */
function resolved(arg: ToolItemArg): boolean {
  return arg.by === 'recall-map' || arg.by === 'recall-revision';
}

/** The node ids the arguments name by id, read from the input alone. */
export function idArgTargets(
  args: readonly ToolItemArg[],
  input: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (resolved(arg)) continue;
    for (const ref of refsOf(arg, input)) {
      const id = nodeId(ref);
      if (id) out.push(id);
    }
  }
  return out;
}

/** The item a resolved reference names, in the current scope: a Recall
 *  map's node, by its slug, a former slug or its id; a Recall revision's
 *  map's node. Null: it names nothing the scope reads. */
async function resolveRef(arg: ToolItemArg, ref: string, ownerId: string): Promise<string | null> {
  if (arg.by === 'recall-map') {
    // Imported at the call: the recall tools' module defines builtins,
    // which import the policy module this one reads.
    const { mapRef } = await import('./builtins-recall-write');
    return (await mapRef(ownerId, ref))?.nodeId ?? null;
  }
  if (arg.by === 'recall-revision') {
    const id = nodeId(ref);
    if (!id) return null;
    const [row] = await db
      .select({ node: recallMaps.nodeId })
      .from(recallRevisions)
      .innerJoin(recallMaps, eq(recallMaps.id, recallRevisions.mapId))
      .where(and(eq(recallRevisions.id, id), eq(recallMaps.ownerId, ownerId)))
      .limit(1);
    return row?.node ?? null;
  }
  return nodeId(ref);
}

/** Whether the audit needs the database for a call's targets. */
export function auditResolves(args: readonly ToolItemArg[]): boolean {
  return args.some(resolved);
}

/** The node ids the resolved arguments name (the audit, before the call
 *  runs: a map a delete removes still names its node). */
export async function resolvedArgTargets(
  args: readonly ToolItemArg[],
  input: Record<string, unknown>,
  ownerId: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const arg of args) {
    if (!resolved(arg)) continue;
    for (const ref of refsOf(arg, input)) {
      const id = await resolveRef(arg, ref, ownerId);
      if (id) out.push(id);
    }
  }
  return out;
}

/** The run's words for an item check's refusal (the one mapper's tool text
 *  for the edit check: "not found" for an item the scope does not read,
 *  whether it exists or not; the item-workspace words for one it reads but
 *  may not change). */
function runAnswer(detail: 'no_read' | 'no_edit'): string {
  return mapAccessError(editCheckRefusalError(detail))?.toolText ?? 'not found';
}

/**
 * Before a call is queued for approval (L2): the refusal its run would give
 * for an item it names, or null. Asked in the queuing scope, which the
 * approved call runs in (pending-origin.ts), with the same rights read the
 * libraries' item check uses (itemWriteRefusalOf):
 *
 *  - a Recall map the scope does not read is the tool's own "No Recall map"
 *    (`missing`), not in a scope that holds Admin (a map a queued
 *    recall_map_create makes may be named; dispatch asks again);
 *  - an item the scope does not read is "not found", whatever the argument
 *    needs (every write reads its item first), unless its `least` is `none`;
 *  - an item it reads but may neither edit nor manage, for an argument
 *    whose `least` is `change` (the run asks one or the other);
 *  - each in the one mapper's words for the edit check, or the argument's
 *    own (`refused`: a link's), as the run answers it.
 *
 * A list argument and a Recall revision are not asked (the module comment).
 * Outside a workspace scope nothing is asked. Asked in every check mode, as
 * main's item pre-check was: on a box whose edit check is warn or off (an
 * operator's lowering) the run would make such a write and log a miss; the
 * queue refuses it, as main did and as the A8 oracle answers.
 */
export async function queueItemRefusal(
  args: readonly ToolItemArg[],
  input: Record<string, unknown>,
  ownerId: string,
): Promise<string | null> {
  if (args.length === 0 || !currentWorkspaceScope()) return null;
  type Named = { id: string; arg: ToolItemArg };
  const change: Named[] = [];
  const read: Named[] = [];
  for (const arg of args) {
    if (arg.least === 'none' || arg.by === 'recall-revision') continue;
    if (Array.isArray(input[arg.param])) continue;
    const [ref] = refsOf(arg, input);
    if (ref === undefined) continue;
    const id = await resolveRef(arg, ref, ownerId);
    if (id === null) {
      if (arg.by === 'recall-map' && arg.missing && !(await scopeHoldsAdmin())) {
        return arg.missing(ref);
      }
      // Not a node id: the tool's own error answers it at run time.
      continue;
    }
    (arg.least === 'read' ? read : change).push({ id, arg });
  }
  if (change.length + read.length === 0) return null;
  const answer = (n: Named, detail: 'no_read' | 'no_edit') =>
    n.arg.refused ? n.arg.refused(detail, n.id) : runAnswer(detail);
  // The library's own read (itemWriteRefusalOf, as assertItemRight asks it).
  for (const n of read) {
    if ((await itemWriteRefusalOf([n.id], 'read'))?.detail === 'no_read') {
      return answer(n, 'no_read');
    }
  }
  for (const n of change) {
    const edit = await itemWriteRefusalOf([n.id], 'edit');
    if (!edit) continue;
    if (edit.detail === 'no_read') return answer(n, 'no_read');
    // A read-only snapshot copy: its own words at run time (a delete of it
    // may still be the copy's author's to make), so not asked here.
    if (edit.copy || edit.detail !== 'no_edit') continue;
    if (await itemWriteRefusalOf([n.id], 'manage')) return answer(n, 'no_edit');
  }
  return null;
}
