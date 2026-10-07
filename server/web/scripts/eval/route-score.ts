/**
 * The pure half of `eval:route` (scripts/eval-route.ts): typed gold cases,
 * the gold rank of one retrieved list, the per-type summary, and the paired
 * gate between two rulesets. No database, so the numbers the routing work is
 * gated on are unit-tested (route-score.test.ts).
 *
 * Question types are the context routing plan's list (dev-brain page
 * "PLAN: Context routing framework (2026-10-03)", section 4.4). A case has
 * ONE primary type; `flags` holds the others that also apply (a verse
 * question names a source AND a reference: type T3, flags [T2]).
 */

export const QUESTION_TYPES = {
  T0: 'small talk',
  T1: 'follow-up',
  T2: 'locate / quote (a rare literal, code, reference)',
  T3: 'scoped lookup (names a source)',
  T4: 'fact lookup',
  T5: 'personal history',
  T6: 'synthesis / explain',
  T7: 'data query',
  T8: 'action',
  default: 'no rule fires',
} as const;
export type QuestionType = keyof typeof QUESTION_TYPES;

export type RouteCase = {
  id: string;
  query: string;
  type: QuestionType;
  flags?: QuestionType[];
  /** Corpus profile of the set (library, business, personal, mixed). */
  profile?: string;
  /** Passage gold: any listed ordinal of the node counts. */
  expectChunks?: Array<{ nodeId: string; ordinals: number[] }>;
  /** Document gold, used when a case has no passage gold. */
  expectNodeIds?: string[];
  expectNodeTitleIncludes?: string[];
  group?: string;
  note?: string;
};

/** One retrieved passage (or node: no ordinal), in rank order. */
export type Hit = { nodeId: string; title: string; ordinal?: number };

const isType = (t: unknown): t is QuestionType =>
  typeof t === 'string' && Object.prototype.hasOwnProperty.call(QUESTION_TYPES, t);

/** Validate a typed case file. Throws with the case id on the first fault. */
export function parseRouteCases(raw: unknown): RouteCase[] {
  if (!Array.isArray(raw)) throw new Error('cases must be a JSON array');
  const seen = new Set<string>();
  return raw.map((c, i) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' && o.id ? o.id : `case-${i + 1}`;
    if (seen.has(id)) throw new Error(`case ${id}: duplicate id`);
    seen.add(id);
    if (typeof o.query !== 'string' || !o.query.trim())
      throw new Error(`case ${id}: "query" is required`);
    if (!isType(o.type))
      throw new Error(
        `case ${id}: "type" must be one of ${Object.keys(QUESTION_TYPES).join(', ')} (got ${String(o.type)})`,
      );
    const flags = Array.isArray(o.flags) ? o.flags : [];
    for (const f of flags) if (!isType(f)) throw new Error(`case ${id}: unknown flag ${String(f)}`);
    const hasGold =
      (Array.isArray(o.expectChunks) && o.expectChunks.length > 0) ||
      (Array.isArray(o.expectNodeIds) && o.expectNodeIds.length > 0) ||
      (Array.isArray(o.expectNodeTitleIncludes) && o.expectNodeTitleIncludes.length > 0);
    if (!hasGold)
      throw new Error(`case ${id}: needs expectChunks, expectNodeIds or expectNodeTitleIncludes`);
    return { ...(o as unknown as RouteCase), id, flags: flags as QuestionType[] };
  });
}

/** 1-based rank of the first gold hit in `hits`, or null. Passage gold when
 *  the case has it (node + ordinal), else document gold (id or title). */
export function goldRankOf(c: RouteCase, hits: readonly Hit[]): number | null {
  if (c.expectChunks?.length) {
    const i = hits.findIndex((h) =>
      c.expectChunks!.some(
        (g) => g.nodeId === h.nodeId && h.ordinal !== undefined && g.ordinals.includes(h.ordinal),
      ),
    );
    return i >= 0 ? i + 1 : null;
  }
  const ids = new Set(c.expectNodeIds ?? []);
  const subs = (c.expectNodeTitleIncludes ?? []).map((s) => s.toLowerCase());
  const i = hits.findIndex(
    (h) => ids.has(h.nodeId) || subs.some((s) => h.title.toLowerCase().includes(s)),
  );
  return i >= 0 ? i + 1 : null;
}

/** One case's outcome under one ruleset. */
export type CaseResult = {
  id: string;
  type: QuestionType;
  profile: string;
  /** Gold rank within the first `k` returned, null = missed. */
  rank: number | null;
  ms: number;
  /** Model spend for this case (USD, estimated from request counts). */
  usd: number;
};

export type TypeSummary = {
  type: QuestionType | 'all';
  n: number;
  r1: number;
  rk: number;
  mrr: number;
  p50: number;
  p90: number;
  usd: number;
};

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Nearest-rank percentile of `xs` (0 for an empty list). */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

function summarize(type: TypeSummary['type'], rs: readonly CaseResult[], k: number): TypeSummary {
  const n = rs.length;
  const hit = (lim: number) => rs.filter((r) => r.rank !== null && r.rank <= lim).length;
  return {
    type,
    n,
    r1: n ? round3(hit(1) / n) : 0,
    rk: n ? round3(hit(k) / n) : 0,
    mrr: n ? round3(rs.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / n) : 0,
    p50: percentile(
      rs.map((r) => r.ms),
      50,
    ),
    p90: percentile(
      rs.map((r) => r.ms),
      90,
    ),
    usd: Math.round(rs.reduce((a, r) => a + r.usd, 0) * 1e5) / 1e5,
  };
}

/** Per type (in QUESTION_TYPES order, only types present) plus `all`. */
export function summarizeByType(results: readonly CaseResult[], k: number): TypeSummary[] {
  const types = (Object.keys(QUESTION_TYPES) as QuestionType[]).filter((t) =>
    results.some((r) => r.type === t),
  );
  return [
    ...types.map((t) =>
      summarize(
        t,
        results.filter((r) => r.type === t),
        k,
      ),
    ),
    summarize('all', results, k),
  ];
}

export type TypeDelta = {
  type: QuestionType | 'all';
  n: number;
  /** Cases the candidate finds within k that the reference missed, and back. */
  wonK: number;
  lostK: number;
  won1: number;
  lost1: number;
};

/**
 * Paired comparison per type (McNemar-style counts): only cases both runs
 * scored count. At n = 98 one point of R@10 is about +-9 points of noise
 * (docs/recall-eval.md), so the gate reads case counts, not percentages.
 */
export function comparePaired(
  reference: readonly CaseResult[],
  candidate: readonly CaseResult[],
  k: number,
): TypeDelta[] {
  const ref = new Map(reference.map((r) => [r.id, r]));
  const pairs = candidate.filter((c) => ref.has(c.id)).map((c) => ({ c, r: ref.get(c.id)! }));
  const within = (x: CaseResult, lim: number) => x.rank !== null && x.rank <= lim;
  const delta = (type: TypeDelta['type'], ps: typeof pairs): TypeDelta => ({
    type,
    n: ps.length,
    wonK: ps.filter(({ c, r }) => within(c, k) && !within(r, k)).length,
    lostK: ps.filter(({ c, r }) => !within(c, k) && within(r, k)).length,
    won1: ps.filter(({ c, r }) => within(c, 1) && !within(r, 1)).length,
    lost1: ps.filter(({ c, r }) => !within(c, 1) && within(r, 1)).length,
  });
  const types = (Object.keys(QUESTION_TYPES) as QuestionType[]).filter((t) =>
    pairs.some(({ c }) => c.type === t),
  );
  return [
    ...types.map((t) =>
      delta(
        t,
        pairs.filter(({ c }) => c.type === t),
      ),
    ),
    delta('all', pairs),
  ];
}

/**
 * The routing gate (plan section 4.7): a ruleset change ships when no type
 * loses more than `maxLoss` cases at R@k or at R@1, and at least one type
 * gains at either (or the `target` type gains, when named). R@1 counts too:
 * on a small corpus R@k sits at the ceiling and only R@1 can move. Returns
 * the reasons it fails, empty when it passes.
 */
export function gateFailures(
  deltas: readonly TypeDelta[],
  opts: { maxLoss?: number; target?: QuestionType } = {},
): string[] {
  const maxLoss = opts.maxLoss ?? 2;
  const perType = deltas.filter((d) => d.type !== 'all');
  const out: string[] = [];
  for (const d of perType) {
    if (d.lostK > maxLoss) out.push(`${d.type} lost ${d.lostK} cases at R@k (limit ${maxLoss})`);
    if (d.lost1 > maxLoss) out.push(`${d.type} lost ${d.lost1} cases at R@1 (limit ${maxLoss})`);
  }
  const gains = (d: TypeDelta) => d.wonK - d.lostK > 0 || d.won1 - d.lost1 > 0;
  if (opts.target) {
    const t = perType.find((d) => d.type === opts.target);
    if (!t || !gains(t)) out.push(`target ${opts.target} did not gain`);
  } else if (!perType.some(gains)) {
    out.push('no type gained');
  }
  return out;
}
