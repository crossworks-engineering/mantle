/**
 * Supersession resolution — the content-currency lineage layer (read side).
 *
 * Ranking demotion of superseded nodes is already materialized into `salience`
 * (see @mantle/content supersede.ts), so retrieval needs nothing here to RANK
 * correctly. What it needs is to TELL the model: when a superseded node still
 * surfaces (demotion is a nudge, not a filter — and a stale file's passage can
 * still be the closest match), the hit must carry "superseded by X" so the
 * model hops to the successor instead of quoting the stale content as current.
 *
 * `resolveSupersededTargets` batch-resolves node ids to the LIVING END of
 * their supersession chain (v01 → v02 → page ⇒ the page), capped at
 * SUPERSEDE_CHAIN_CAP hops. Cycles cannot be written (the content-layer guard
 * refuses them), so the cap only bounds pathological hand-edited data.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';

/** Keep in sync with @mantle/content SUPERSEDE_CHAIN_CAP (not imported — the
 *  packages are intentionally independent). */
export const SUPERSEDE_CHAIN_CAP = 5;

export type SupersededTarget = {
  /** The living end of the chain. */
  id: string;
  title: string;
  /** Chain length from the queried node (1 = direct successor). */
  hops: number;
};

/**
 * Pure chain walk over preloaded edges: for each queried id that has a
 * successor, follow `successorOf` to the last reachable node (something with
 * no outgoing edge), capped. Returns only entries for ids that ARE superseded.
 * Exported for tests; the DB wrapper below feeds it.
 */
export function terminalSuccessors(
  successorOf: ReadonlyMap<string, string>,
  ids: readonly string[],
  cap: number = SUPERSEDE_CHAIN_CAP,
): Map<string, { id: string; hops: number }> {
  const out = new Map<string, { id: string; hops: number }>();
  for (const start of ids) {
    let cur = successorOf.get(start);
    if (!cur) continue;
    let hops = 1;
    while (hops < cap) {
      const next = successorOf.get(cur);
      if (!next) break;
      cur = next;
      hops++;
    }
    out.set(start, { id: cur, hops });
  }
  return out;
}

/**
 * Resolve superseded node ids to their living successors, batched: at most
 * `SUPERSEDE_CHAIN_CAP` small indexed queries regardless of input size, and
 * zero queries when no input node is superseded (the common case — callers
 * pass every hit; the first probe touches only the partial index).
 */
export async function resolveSupersededTargets(
  ownerId: string,
  ids: readonly string[],
): Promise<Map<string, SupersededTarget>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();

  // Load the successor edges reachable from the input set, level by level.
  const successorOf = new Map<string, string>();
  let frontier = unique;
  for (let level = 0; level < SUPERSEDE_CHAIN_CAP && frontier.length > 0; level++) {
    const rows = await db
      .select({ id: nodes.id, supersededBy: nodes.supersededBy })
      .from(nodes)
      .where(
        and(eq(nodes.ownerId, ownerId), inArray(nodes.id, frontier), isNotNull(nodes.supersededBy)),
      );
    const next: string[] = [];
    for (const r of rows) {
      if (!r.supersededBy || successorOf.has(r.id)) continue;
      successorOf.set(r.id, r.supersededBy);
      if (!successorOf.has(r.supersededBy)) next.push(r.supersededBy);
    }
    frontier = next;
  }
  if (successorOf.size === 0) return new Map();

  const terminals = terminalSuccessors(successorOf, unique);
  const terminalIds = [...new Set([...terminals.values()].map((t) => t.id))];
  const titleRows = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, terminalIds)));
  const titleById = new Map(titleRows.map((r) => [r.id, r.title]));

  const out = new Map<string, SupersededTarget>();
  for (const [start, t] of terminals) {
    const title = titleById.get(t.id);
    // A dangling successor id (deleted node) has no title — skip the
    // annotation rather than pointing the model at a ghost.
    if (title === undefined) continue;
    out.set(start, { id: t.id, title, hops: t.hops });
  }
  return out;
}
