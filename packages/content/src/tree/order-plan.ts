/**
 * What a place in a folder's custom order writes (docs/folder-tree.md,
 * "Custom order"): the ranks, worked out from the folder's other children
 * as the tree shows them. No database here, so the rules are pinned by
 * order-plan.test.ts; write.ts orderChildren reads the rows and writes the
 * plan.
 */
import { rankBetween, ranksSpread } from '../rank';

/** One of the folder's other children, in the order the tree shows them:
 *  its rank when it carries a valid one, and whether it is a read-only
 *  snapshot copy (it never takes a rank, and is no neighbour). */
export type OrderRow = { id: string; rank: string | null; copy: boolean };

export type RankWrite = { id: string; rank: string };

/** The longest rank one place writes between two neighbours: past it the
 *  folder is ranked again, so keys stay well inside RANK_RE's 64. */
export const RANK_MAX_LEN = 48;

/** The most children a folder may hold for a place that ranks it (the
 *  first place in an unordered folder, or one whose neighbours leave no
 *  room): a larger folder is refused that place (409), so no place reads
 *  the rights of, or writes, more rows than this. A place between two
 *  ranked neighbours writes one row in a folder of any size. */
export const TREE_ORDER_MAX = 5000;

/** The nearest children before and after position `at` that are not
 *  copies: a copy shows where its inherited rank (or none) puts it, so it
 *  never bounds a place, and its rank never ties with one. */
function neighbours(rows: readonly OrderRow[], at: number): { prev?: OrderRow; next?: OrderRow } {
  let prev: OrderRow | undefined;
  for (let i = at - 1; i >= 0; i--) {
    if (!rows[i]!.copy) {
      prev = rows[i];
      break;
    }
  }
  let next: OrderRow | undefined;
  for (let i = at; i < rows.length; i++) {
    if (!rows[i]!.copy) {
      next = rows[i];
      break;
    }
  }
  return { prev, next };
}

/** The rank that puts the moved child at position `at` (before rows[at])
 *  writing it alone, or null when its neighbours leave no room: one has no
 *  rank, the two tie or are out of order, or the key would grow past
 *  RANK_MAX_LEN. */
export function rankAt(rows: readonly OrderRow[], at: number): string | null {
  const { prev, next } = neighbours(rows, at);
  const lo = prev ? prev.rank : null;
  const hi = next ? next.rank : null;
  if ((prev && lo === null) || (next && hi === null)) return null;
  if (lo !== null && hi !== null && lo >= hi) return null;
  const rank = rankBetween(lo, hi);
  return rank.length <= RANK_MAX_LEN ? rank : null;
}

/**
 * The writes of a place whose neighbours leave no room (rankAt null), only
 * ever to rows `mayWrite` allows and never to a copy:
 *
 *  - in a folder that already has an order, every rank stays: the children
 *    with none take keys after the last one, in the order they show, and
 *    the moved child goes between its neighbours. A member's place then
 *    leaves the items it does not see where they were;
 *  - in a folder with no order yet, or when that still leaves no room (a
 *    tie, a key grown long), the children are ranked whole, evenly, in the
 *    order they show with the moved one at `at`.
 */
export function planWhole(
  rows: readonly OrderRow[],
  at: number,
  movingId: string,
  ordered: boolean,
  mayWrite: (id: string) => boolean,
): RankWrite[] {
  if (ordered) {
    const appended = appendRanks(rows, mayWrite);
    if (appended.size) {
      const ranked = rows.map((r) => {
        const rank = appended.get(r.id);
        return rank === undefined ? r : { ...r, rank };
      });
      const rank = rankAt(ranked, at);
      if (rank !== null) {
        return [...[...appended].map(([id, k]) => ({ id, rank: k })), { id: movingId, rank }];
      }
    }
  }
  const order = [...rows.slice(0, at), { id: movingId, rank: null, copy: false }, ...rows.slice(at)]
    .filter((r) => r.id === movingId || (!r.copy && mayWrite(r.id)))
    .map((r) => r.id);
  const ranks = ranksSpread(order.length);
  return order.map((id, k) => ({ id, rank: ranks[k]! }));
}

/** Keys after the last rank for the children with none (that `mayWrite`
 *  allows, not copies), in the order they show: one prefix past the last
 *  rank and an even spread under it, so they stay short however many. An
 *  empty map when there are none, or the keys would grow too long. */
function appendRanks(
  rows: readonly OrderRow[],
  mayWrite: (id: string) => boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  const unranked = rows.filter((r) => !r.copy && r.rank === null && mayWrite(r.id));
  if (!unranked.length) return out;
  let last: string | null = null;
  for (const r of rows)
    if (!r.copy && r.rank !== null && (last === null || r.rank > last)) last = r.rank;
  const prefix = rankBetween(last, null);
  const keys = ranksSpread(unranked.length).map((k) => prefix + k);
  if (keys.some((k) => k.length > RANK_MAX_LEN)) return out;
  unranked.forEach((r, i) => out.set(r.id, keys[i]!));
  return out;
}
