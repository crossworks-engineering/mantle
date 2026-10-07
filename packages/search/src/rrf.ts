/**
 * Weighted Reciprocal-Rank Fusion — the pure core of hybrid ranking.
 *
 * Each arm contributes `weight / (k + rank)` per id (rank is 1-based); ids are
 * returned by descending fused score, capped at `limit`. Extracted so the
 * fusion is unit-testable without a DB and so `searchChunks` shares the exact
 * recipe `searchNodes` established (k = 60, vector-led weights) rather than
 * re-deriving it. Ties keep first-arm-order stability (Map insertion order —
 * `sort` is stable in V8).
 */

export const RRF_K = 60;

export type RrfArm = {
  /** Ranked ids, best first. Duplicates within one arm keep the best rank. */
  ids: string[];
  /** This arm's share of the blend, 0..1 across all arms. */
  weight: number;
};

export function fuseRrf(arms: RrfArm[], limit: number, k = RRF_K): string[] {
  const score = new Map<string, number>();
  for (const arm of arms) {
    const seen = new Set<string>();
    arm.ids.forEach((id, i) => {
      if (seen.has(id)) return; // best (earliest) rank wins within an arm
      seen.add(id);
      score.set(id, (score.get(id) ?? 0) + arm.weight / (k + i + 1));
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit))
    .map(([id]) => id);
}

/**
 * Rescue floor for the booster arm. Down-weighted RRF has a blind spot the
 * fusion alone can't fix: a hit known ONLY to the booster arm scores
 * `w_booster/(k+1)`, which loses to every spine hit down to rank
 * `k·(w_spine/w_booster − 1) + limit` — at 0.7/0.3 and k=60 that's rank ~82,
 * so an exact-term match absent from the vector pool NEVER cracks a top-10
 * cut. That is precisely the failure hybrid exists to fix (the audit's
 * verbatim-term-declared-absent case). So: guarantee the booster's top
 * `slots` hits a place at the TAIL of the cut — present for the model to see,
 * never displacing the vector-led head order.
 */
export function applyRescueFloor(
  fused: string[],
  boosterIds: string[],
  limit: number,
  slots = 2,
): string[] {
  const cap = Math.max(0, limit);
  const head = fused.slice(0, cap);
  const rescue = boosterIds.slice(0, Math.max(0, slots)).filter((id) => !head.includes(id));
  if (rescue.length === 0) return head;
  return [...head.slice(0, Math.max(0, cap - rescue.length)), ...rescue];
}

/**
 * Merge two ranked lists, the first list first (passage windows: the hybrid
 * order, then the window arm). An id already taken is skipped.
 *
 *  - `turns`: a1, b1, a2, b2, ... up to `limit`. For a list that is cut
 *    straight into the prompt: both heads reach the cut.
 *  - `union`: the top `limit / 2` of the first list, then the top
 *    `limit / 2` of the second that are not in it (so it can come back
 *    shorter than `limit`). For a pool a judge scores in requests of 25: the
 *    first list's head stays together in the first requests.
 *
 * Measured on the library corpus (docs/recall-eval.md, "Passage windows"):
 * with the judge, `union` kept rank-1 answers that a `turns` pool of the
 * same depth lost; without the judge, `turns` put more answers in the top 8.
 */
export type MergeOrder = 'turns' | 'union';

export function mergeIds(
  first: string[],
  second: string[],
  limit: number,
  order: MergeOrder = 'turns',
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const cap = Math.max(0, limit);
  const take = (id: string | undefined) => {
    if (id === undefined || seen.has(id) || out.length >= cap) return;
    seen.add(id);
    out.push(id);
  };
  if (order === 'union') {
    const half = Math.ceil(cap / 2);
    first.slice(0, half).forEach(take);
    second.slice(0, half).forEach(take);
    return out;
  }
  for (let i = 0; out.length < cap && (i < first.length || i < second.length); i++) {
    take(first[i]);
    take(second[i]);
  }
  return out;
}
