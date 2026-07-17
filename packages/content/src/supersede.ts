/**
 * Node-level supersession — the content-currency lineage layer (write side).
 *
 * The problem this solves (measured on NATREF, 2026-07-17): source files whose
 * content was migrated into corrected pages kept ranking at full weight — the
 * stale file often carries MORE chunks than its successor page, so passage
 * queries preferred the dead document, and the responder cited rev0 .docx
 * sources daily. Facts have had first-class supersession for months
 * (facts.superseded_by); this lifts the same primitive to nodes.
 *
 * Semantics:
 *  - `superseded_by` is the SOURCE OF TRUTH; ranking demotion is MATERIALIZED
 *    into `salience` at write time so the existing effective-distance
 *    expression (`dist + λ·(1-salience)`) picks it up with ZERO query changes.
 *    A down-weight, never a filter — superseded content stays findable.
 *  - Reversible: `unsupersedeNode` clears the edge and restores salience 1.
 *    (Restoring to 1 is correct for every real writer today — files, pages,
 *    notes. Bulk-mail salience is set on EMAILS, which nothing supersedes.)
 *  - Cycle-safe: the write walks the successor chain first and refuses a mark
 *    that would close a loop (A→B→A never exists, so read-path walks are
 *    bounded by construction; the hop cap is belt-and-suspenders).
 *
 * Read-side (annotation + terminal-successor resolution) lives in
 * @mantle/search (resolveSupersededTargets) so tools and the agent runtime can
 * use it without new package dependencies.
 */
import { and, eq } from 'drizzle-orm';
import { db, nodes, type Node } from '@mantle/db';

export type SupersedeReason = 'version' | 'migrated' | 'corrected';

/** Salience a superseded node drops to. 'corrected' (an explicit "this is
 *  wrong") demotes harder than 'version'/'migrated' (merely older). Both are
 *  re-ranking nudges on the existing λ path, not hides. */
const SUPERSEDED_SALIENCE = clamp01(Number(process.env.MANTLE_SUPERSEDED_SALIENCE ?? 0.5));
const CORRECTED_SALIENCE = clamp01(Number(process.env.MANTLE_CORRECTED_SALIENCE ?? 0.3));

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

export function salienceForSupersedeReason(reason: SupersedeReason): number {
  return reason === 'corrected' ? CORRECTED_SALIENCE : SUPERSEDED_SALIENCE;
}

/** Max successor hops any walk will follow. Cycles can't be written (the guard
 *  below), so this only bounds pathological hand-edited data. Keep in sync with
 *  @mantle/search resolveSupersededTargets. */
export const SUPERSEDE_CHAIN_CAP = 5;

/**
 * Pure cycle check over a preloaded successor map: would setting
 * `from.superseded_by = to` close a loop? True when walking `to`'s successor
 * chain reaches `from` (including the degenerate `from === to`). The walk is
 * capped — an existing malformed cycle beyond the cap reads as unreachable,
 * which REJECTS the write (safe direction).
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
 * Mark a node superseded: set the lineage edge + reason and materialize the
 * salience demotion. Idempotent — re-marking updates the edge/reason in place.
 * Throws on: missing node, missing successor, cross-owner successor, self- or
 * cycle-closing marks.
 */
export async function supersedeNode(input: SupersedeNodeInput): Promise<Node> {
  const successorId = input.supersededBy ?? null;
  if (successorId === input.id) {
    throw new Error('supersede: a node cannot supersede itself');
  }
  const [target] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.ownerId, input.ownerId), eq(nodes.id, input.id)))
    .limit(1);
  if (!target) throw new Error('supersede: node not found');

  if (successorId) {
    const [successor] = await db
      .select({ id: nodes.id, supersededBy: nodes.supersededBy })
      .from(nodes)
      .where(and(eq(nodes.ownerId, input.ownerId), eq(nodes.id, successorId)))
      .limit(1);
    if (!successor) throw new Error('supersede: successor node not found');

    // Walk the successor's chain (bounded) to refuse cycle-closing marks.
    const chain = new Map<string, string>();
    let cur = successor.supersededBy;
    let prev = successor.id;
    for (let hops = 0; cur && hops < SUPERSEDE_CHAIN_CAP; hops++) {
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
    if (wouldCreateSupersedeCycle(chain, input.id, successor.id)) {
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
  const [row] = await db
    .update(nodes)
    .set({ supersededBy: null, supersededReason: null, salience: 1, updatedAt: new Date() })
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.id, id)))
    .returning();
  if (!row) throw new Error('supersede: node not found');
  return row;
}
