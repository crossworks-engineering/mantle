/**
 * The scorer for PDF drawing extraction (plan page 11a16779, sections 6 and
 * 9.3). Plain JSON in, numbers out. Phase 0: no product code imports it.
 *
 * Input: the candidates an engine extracted, a truth set (the hand-checked
 * gold sheets, or the catalog built from the DWGs), and optionally the
 * engine's own per-page accounting of tag-like text runs.
 *
 * Output: tag recall and precision, service text exact match, condition-cell
 * accuracy, foreign-unit tags, and the per-page accounting check (every
 * tag-like run ends as a candidate, as template text, or as rejected with a
 * reason, and the counts add up).
 *
 * The result holds numbers and fixed labels only, so it may leave a client
 * box. `detail: true` adds the tag lists, for a local run on our own
 * drawings only.
 */

export type Candidate = {
  tag: string;
  page?: number;
  service?: string;
  /** Condition cells by key (design pressure, operating temperature ...). */
  conditions?: Record<string, string | number | null | undefined>;
};

export type TruthRow = {
  tag: string;
  service?: string;
  conditions?: Record<string, string | number | null | undefined>;
};

/** One page's accounting, as the engine states it. */
export type PageAccount = {
  page: number;
  /** Tag-like text runs the engine saw on the page. */
  tagLike: number;
  candidate: number;
  template: number;
  /** Rejected runs by reason. A reason is a non-empty label. */
  rejected: Record<string, number>;
};

export type ScoreInput = {
  candidates: Candidate[];
  truth: TruthRow[];
  pages?: PageAccount[];
  /** Unit codes that belong to this set (the text before the first '-').
   *  When left out, the units of the truth tags. */
  units?: string[];
  /** Treat `E-01` and `E-1` as one tag (plan S3). Default true. */
  stripLeadingZeros?: boolean;
  detail?: boolean;
};

export type Ratio = { n: number; of: number; value: number | null };

export type ScoreResult = {
  tags: { truth: number; found: number; matched: number };
  recall: Ratio;
  precision: Ratio;
  serviceExact: Ratio;
  conditionCells: Ratio;
  foreignUnitTags: number;
  accounting: {
    pages: number;
    pagesOk: number;
    /** Pages whose outcomes do not add up to tagLike. */
    sumMismatch: number;
    /** Pages with a rejected count under an empty reason. */
    rejectedNoReason: number;
    /** Pages whose `candidate` count differs from the candidates listed for that page. */
    candidateMismatch: number;
    /** Pages with a negative or non-integer count. */
    badCounts: number;
    ok: boolean;
  } | null;
  options: { stripLeadingZeros: boolean; units: 'given' | 'from_truth' };
  detail?: { missed: string[]; extra: string[]; foreign: string[] };
};

const ratio = (n: number, of: number): Ratio => ({
  n,
  of,
  value: of === 0 ? null : Math.round((n / of) * 10_000) / 10_000,
});

/** The canonical form of a tag: trimmed, upper case, no inner spaces, one
 *  kind of dash, and (by default) no leading zeros in a number part. */
export function canonicalTag(raw: string, stripLeadingZeros = true): string {
  let t = raw
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, '');
  if (stripLeadingZeros) {
    t = t
      .split('-')
      .map((part) => part.replace(/^0+(?=\d)/, ''))
      .join('-');
  }
  return t;
}

/** The unit code of a canonical tag: the part before the first '-'. */
export function unitOf(tag: string): string {
  const i = tag.indexOf('-');
  return i > 0 ? tag.slice(0, i) : '';
}

/** Text compared for an exact match: whitespace collapsed, upper case. */
export function canonicalText(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** A condition cell compared as a value: text rules, plus a decimal comma
 *  read as a point and a number compared as a number ("23,60" = "23.6"). */
export function canonicalCell(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  const s = canonicalText(String(raw)).replace(/\s*\/\s*/g, '/');
  const num = s.replace(',', '.');
  if (/^[-+]?\d+(\.\d+)?$/.test(num)) return String(Number(num));
  return s;
}

/** The most common non-empty value; on a tie, the first seen. */
function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  let best = '';
  let bestN = 0;
  for (const v of values) {
    if (!v) continue;
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

export function score(input: ScoreInput): ScoreResult {
  const strip = input.stripLeadingZeros ?? true;
  const truth = new Map<string, TruthRow>();
  for (const row of input.truth) {
    const t = canonicalTag(row.tag, strip);
    if (t && !truth.has(t)) truth.set(t, row);
  }
  const found = new Map<string, Candidate[]>();
  for (const c of input.candidates) {
    const t = canonicalTag(c.tag, strip);
    if (!t) continue;
    const list = found.get(t);
    if (list) list.push(c);
    else found.set(t, [c]);
  }

  const units = new Set(
    (input.units ?? [...truth.keys()].map(unitOf))
      .map((u) => canonicalTag(u, false))
      .filter(Boolean),
  );

  let matched = 0;
  let serviceN = 0;
  let serviceOf = 0;
  let cellN = 0;
  let cellOf = 0;
  const missed: string[] = [];
  for (const [tag, row] of truth) {
    const cands = found.get(tag);
    if (!cands) {
      missed.push(tag);
    } else {
      matched++;
    }
    // Service and cells are scored over every truth row that has them: a
    // missed tag counts as a wrong service and wrong cells.
    if (row.service && canonicalText(row.service)) {
      serviceOf++;
      const got = mostCommon((cands ?? []).map((c) => canonicalText(c.service ?? '')));
      if (got && got === canonicalText(row.service)) serviceN++;
    }
    for (const [key, want] of Object.entries(row.conditions ?? {})) {
      const w = canonicalCell(want);
      if (!w) continue;
      cellOf++;
      const got = mostCommon((cands ?? []).map((c) => canonicalCell(c.conditions?.[key])));
      if (got && got === w) cellN++;
    }
  }

  const extra: string[] = [];
  const foreign: string[] = [];
  for (const tag of found.keys()) {
    if (!truth.has(tag)) extra.push(tag);
    if (!units.has(unitOf(tag))) foreign.push(tag);
  }

  let accounting: ScoreResult['accounting'] = null;
  if (input.pages) {
    const perPage = new Map<number, number>();
    for (const c of input.candidates) {
      if (typeof c.page === 'number') perPage.set(c.page, (perPage.get(c.page) ?? 0) + 1);
    }
    const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
    let pagesOk = 0;
    let sumMismatch = 0;
    let rejectedNoReason = 0;
    let candidateMismatch = 0;
    let badCounts = 0;
    for (const p of input.pages) {
      const rej = Object.entries(p.rejected ?? {});
      const counts = [p.tagLike, p.candidate, p.template, ...rej.map(([, n]) => n)];
      const bad = !counts.every(isCount);
      const noReason = rej.some(([reason, n]) => !reason.trim() && n > 0);
      const sum = p.candidate + p.template + rej.reduce((s, [, n]) => s + n, 0);
      const sumBad = sum !== p.tagLike;
      const candBad = (perPage.get(p.page) ?? 0) !== p.candidate;
      if (bad) badCounts++;
      if (noReason) rejectedNoReason++;
      if (sumBad) sumMismatch++;
      if (candBad) candidateMismatch++;
      if (!bad && !noReason && !sumBad && !candBad) pagesOk++;
    }
    accounting = {
      pages: input.pages.length,
      pagesOk,
      sumMismatch,
      rejectedNoReason,
      candidateMismatch,
      badCounts,
      ok: pagesOk === input.pages.length,
    };
  }

  const result: ScoreResult = {
    tags: { truth: truth.size, found: found.size, matched },
    recall: ratio(matched, truth.size),
    precision: ratio(matched, found.size),
    serviceExact: ratio(serviceN, serviceOf),
    conditionCells: ratio(cellN, cellOf),
    foreignUnitTags: foreign.length,
    accounting,
    options: { stripLeadingZeros: strip, units: input.units ? 'given' : 'from_truth' },
  };
  if (input.detail) {
    result.detail = { missed: missed.sort(), extra: extra.sort(), foreign: foreign.sort() };
  }
  return result;
}
