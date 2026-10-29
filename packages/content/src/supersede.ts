/**
 * Node-level supersession — the content-currency lineage layer (write side).
 *
 * The problem this solves: source files whose content was migrated into
 * corrected pages would keep ranking at full weight — the stale file often
 * carries MORE chunks than its successor page, so passage queries prefer the
 * dead document and the responder cites outdated sources. Facts have
 * first-class supersession (facts.superseded_by); this lifts the same
 * primitive to nodes.
 *
 * Semantics:
 *  - `superseded_by` is the SOURCE OF TRUTH; ranking demotion is MATERIALIZED
 *    into `salience` at write time so the existing effective-distance
 *    expression (`dist + λ·(1-salience)`) picks it up with ZERO query changes.
 *    A down-weight, never a filter — superseded content stays findable.
 *  - Reversible: `unsupersedeNode` clears the edge and restores salience 1.
 *    Restoring to 1 is correct because supersession never applies to nodes
 *    whose salience another subsystem manages: emails carry ingest-assigned
 *    bulk-mail weights (salienceForDeliveryKind), so `supersedeNode` REFUSES
 *    email (and branch) targets — enforced below, not just assumed.
 *  - Cycle-safe: the write walks the successor's FULL chain first and refuses
 *    a mark that would close a loop, so read-path walks are bounded by
 *    construction. (Two concurrent marks racing each other are the one
 *    remaining window — the read-side hop cap keeps even that bounded.)
 *
 * Read-side (annotation + terminal-successor resolution) lives in
 * @mantle/search (resolveSupersededTargets) so tools and the agent runtime can
 * use it without new package dependencies.
 */
import { and, eq } from 'drizzle-orm';
import { assertItemRight, db, type Node, nodes } from '@mantle/db';
import { envNum } from '@mantle/config';

export type SupersedeReason = 'version' | 'migrated' | 'corrected';

/** Salience a superseded node drops to. 'corrected' (an explicit "this is
 *  wrong") demotes harder than 'version'/'migrated' (merely older). Both are
 *  re-ranking nudges on the existing λ path, not hides. */
const SUPERSEDED_SALIENCE = envNum('MANTLE_SUPERSEDED_SALIENCE');
const CORRECTED_SALIENCE = envNum('MANTLE_CORRECTED_SALIENCE');

export function salienceForSupersedeReason(reason: SupersedeReason): number {
  return reason === 'corrected' ? CORRECTED_SALIENCE : SUPERSEDED_SALIENCE;
}

/** Max successor hops a READ-side walk will follow. Cycles can't be written
 *  (the exact guard below), so this only bounds pathological hand-edited data.
 *  Keep in sync with @mantle/search resolveSupersededTargets. */
export const SUPERSEDE_CHAIN_CAP = 5;

/**
 * Pure cycle check over a preloaded successor map: would setting
 * `from.superseded_by = to` close a loop? True when walking `to`'s successor
 * chain reaches `from` (including the degenerate `from === to`). The cap only
 * guarantees termination on a MALFORMED map (a pre-existing cycle not
 * involving `from`) — for exact detection callers must preload the full chain
 * and pass a cap ≥ its length, as `supersedeNode` does. A cap smaller than the
 * chain makes a deep `from` read as unreachable, i.e. ACCEPTS the write.
 */
export function wouldCreateSupersedeCycle(
  successorOf: ReadonlyMap<string, string>,
  from: string,
  to: string,
  cap: number = SUPERSEDE_CHAIN_CAP,
): boolean {
  let cur: string | undefined = to;
  for (let hops = 0; cur !== undefined && hops <= cap; hops++) {
    if (cur === from) return true;
    cur = successorOf.get(cur);
  }
  return false;
}

export type SupersedeNodeInput = {
  ownerId: string;
  /** The node being retired. */
  id: string;
  /** Its replacement. Omit for a bare "this is outdated" mark (demotion with
   *  no pointer — still reversible). */
  supersededBy?: string | null;
  reason: SupersedeReason;
};

/**
 * The item check of a supersede mark or its undo (pre-check removal Part 3): the database
 * does not watch the columns a mark writes (superseded_by, its reason, the
 * salience) on a read-only copy, so this is the check of every way in: an
 * edit of each item, in the caller's scope. A conversion that retires its
 * sources (page_from_*) asks it before it makes its page. System work is
 * not checked.
 */
export async function assertMaySupersede(ids: readonly string[]): Promise<void> {
  for (const id of ids) await assertItemRight(id, 'edit');
}

/**
 * Mark a node superseded: set the lineage edge + reason and materialize the
 * salience demotion. Idempotent — re-marking updates the edge/reason in place.
 * Throws on: missing node, email/branch targets (their salience is managed
 * elsewhere / supersession is meaningless), missing successor, cross-owner
 * successor, self- or cycle-closing marks.
 */
export async function supersedeNode(input: SupersedeNodeInput): Promise<Node> {
  const successorId = input.supersededBy ?? null;
  if (successorId === input.id) {
    throw new Error('supersede: a node cannot supersede itself');
  }
  await assertMaySupersede([input.id]);
  const [target] = await db
    .select({ id: nodes.id, type: nodes.type })
    .from(nodes)
    .where(and(eq(nodes.ownerId, input.ownerId), eq(nodes.id, input.id)))
    .limit(1);
  if (!target) throw new Error('supersede: node not found');
  // Emails carry ingest-assigned bulk-mail salience (salienceForDeliveryKind);
  // a supersede/undo round-trip would clobber that weighting — and the newer
  // message in a thread already outranks the old one naturally.
  if (target.type === 'email') {
    throw new Error(
      'supersede: emails cannot be superseded — their retrieval weight is assigned at ingest, and newer messages in the thread already take precedence.',
    );
  }
  if (target.type === 'branch') {
    throw new Error(
      'supersede: folders cannot be superseded — mark the specific content nodes inside instead.',
    );
  }

  if (successorId) {
    const [successor] = await db
      .select({ id: nodes.id, supersededBy: nodes.supersededBy })
      .from(nodes)
      .where(and(eq(nodes.ownerId, input.ownerId), eq(nodes.id, successorId)))
      .limit(1);
    if (!successor) throw new Error('supersede: successor node not found');

    // Walk the successor's FULL chain to refuse cycle-closing marks — exact,
    // not capped: a capped walk would ACCEPT a mark whose cycle closes beyond
    // the cap. Terminates on the chain's end, a missing row, or a repeated
    // node (a pre-existing malformed cycle in hand-edited data).
    const chain = new Map<string, string>();
    let cur = successor.supersededBy;
    let prev = successor.id;
    while (cur && !chain.has(prev)) {
      chain.set(prev, cur);
      const [next] = await db
        .select({ id: nodes.id, supersededBy: nodes.supersededBy })
        .from(nodes)
        .where(and(eq(nodes.ownerId, input.ownerId), eq(nodes.id, cur)))
        .limit(1);
      if (!next) break;
      prev = next.id;
      cur = next.supersededBy;
    }
    if (wouldCreateSupersedeCycle(chain, input.id, successor.id, chain.size + 1)) {
      throw new Error(
        'supersede: refusing a mark that would close a supersession cycle — ' +
          "the proposed successor is itself (transitively) superseded by this node; clear that mark first (undo) if it's wrong.",
      );
    }
  }

  const [row] = await db
    .update(nodes)
    .set({
      supersededBy: successorId,
      supersededReason: input.reason,
      salience: salienceForSupersedeReason(input.reason),
      updatedAt: new Date(),
    })
    .where(and(eq(nodes.ownerId, input.ownerId), eq(nodes.id, input.id)))
    .returning();
  if (!row) throw new Error('supersede: update returned no row');
  return row;
}

/** Undo a supersession mark: clear the edge + reason, restore full salience. */
export async function unsupersedeNode(ownerId: string, id: string): Promise<Node> {
  await assertMaySupersede([id]);
  // Read in the caller's scope first, as supersedeNode does: the write runs on the system pool in a scope, so an id the scope
  // does not read must never be changed, nor its title returned.
  const [seen] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.id, id)))
    .limit(1);
  if (!seen) throw new Error('supersede: node not found');
  const [row] = await db
    .update(nodes)
    .set({ supersededBy: null, supersededReason: null, salience: 1, updatedAt: new Date() })
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.id, id)))
    .returning();
  if (!row) throw new Error('supersede: node not found');
  return row;
}
