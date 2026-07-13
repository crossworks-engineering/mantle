/**
 * Recall-evaluation scoring — the pure half of the automated retrieval eval
 * (docs/recall-eval.md). A golden case pairs a natural-language query with the
 * node(s) that should come back; a retriever's ranked hits are scored with
 * recall@k and MRR. The orchestration (embedding queries, running retrievers,
 * persisting run notes) lives in the `recall_eval` builtin — these helpers stay
 * pure so the metric math is unit-testable and identical everywhere.
 */

export type RecallEvalCase = {
  id: string;
  query: string;
  /** Gold node ids — a hit with one of these ids is a gold hit. */
  expectNodeIds?: string[];
  /** Case-insensitive title substrings — a hit whose title contains one is gold. */
  expectTitleIncludes?: string[];
};

export type RecallScores = {
  cases: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
};

/** Parse + validate a golden-case set from untrusted JSON (the cases note). */
export function parseEvalCases(raw: unknown): RecallEvalCase[] {
  if (!Array.isArray(raw)) throw new Error('cases must be a JSON array');
  return raw.map((c, i) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' && o.id ? o.id : `case-${i + 1}`;
    const query = typeof o.query === 'string' ? o.query.trim() : '';
    if (!query) throw new Error(`case ${id}: "query" (non-empty string) is required`);
    const strArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : undefined;
    const expectNodeIds = strArr(o.expectNodeIds);
    // Accept the eval-recall.ts field name too, so the repo golden set pastes in unchanged.
    const expectTitleIncludes = strArr(o.expectTitleIncludes) ?? strArr(o.expectNodeTitleIncludes);
    if (!expectNodeIds?.length && !expectTitleIncludes?.length) {
      throw new Error(`case ${id}: needs "expectNodeIds" or "expectTitleIncludes"`);
    }
    return { id, query, expectNodeIds, expectTitleIncludes };
  });
}

/** 1-based rank of the first gold hit, or null when no gold hit is ranked. */
export function goldRank(
  c: RecallEvalCase,
  hits: Array<{ id: string; title: string }>,
): number | null {
  const ids = new Set(c.expectNodeIds ?? []);
  const subs = (c.expectTitleIncludes ?? []).map((s) => s.toLowerCase());
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    if (ids.has(h.id)) return i + 1;
    const t = h.title.toLowerCase();
    if (subs.some((s) => t.includes(s))) return i + 1;
  }
  return null;
}

/** Aggregate per-case gold ranks into recall@k + MRR. */
export function scoreRanks(ranks: Array<number | null>): RecallScores {
  const n = ranks.length;
  const at = (k: number) => (n === 0 ? 0 : ranks.filter((r) => r !== null && r <= k).length / n);
  const mrr = n === 0 ? 0 : ranks.reduce<number>((a, r) => a + (r ? 1 / r : 0), 0) / n;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    cases: n,
    recallAt1: round(at(1)),
    recallAt3: round(at(3)),
    recallAt5: round(at(5)),
    recallAt10: round(at(10)),
    mrr: round(mrr),
  };
}
