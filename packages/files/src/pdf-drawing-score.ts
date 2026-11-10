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
 * reason, and the counts add up). Nothing is dropped unseen: truth rows that
 * fall on one tag, tags empty after the canonical form, candidate rows that
 * disagree, and candidates outside the accounting are all counted.
 *
 * Exact means every candidate row that gives a field gives the right value:
 * one wrong row makes the field wrong, whatever the other rows say. The
 * result does not depend on the order of the input.
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
  /** Unit codes that belong to this set (the text before the first '-'),
   *  put through the same canonical form as the tags. When left out, the
   *  units of the truth tags. */
  units?: string[];
  /** Treat `E-01` and `E-1` as one tag (the leading-zero rule). Default true. */
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
  /** Truth rows whose canonical tag an earlier row has too. They are kept
   *  and scored with that tag: a field where the rows give different values
   *  counts, and is never right. */
  truthCollisions: number;
  /** Tags whose candidate rows give different values for one field. */
  conflicts: number;
  /** Rows whose tag is empty after the canonical form (not scored). */
  emptyTags: { truth: number; candidates: number };
  accounting: {
    pages: number;
    pagesOk: number;
    /** Pages whose outcomes do not add up to tagLike. */
    sumMismatch: number;
    /** Pages with a rejected count under an empty reason. */
    rejectedNoReason: number;
    /** Pages whose `candidate` count differs from the candidates listed for that page. */
    candidateMismatch: number;
    /** Pages with a negative or non-integer count, or listed twice. */
    badCounts: number;
    /** Candidates with no page, or a page the accounting does not list. */
    unaccounted: number;
    ok: boolean;
  } | null;
  options: { stripLeadingZeros: boolean; units: 'given' | 'from_truth' };
  detail?: {
    missed: string[];
    extra: string[];
    foreign: string[];
    truthCollisions: string[];
    conflicts: string[];
  };
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

/** A condition cell compared as a value: text rules, plus two more.
 *
 *  A comma is a decimal point only when it is the one comma in the cell,
 *  with a digit before it and 1 or 2 digits (no third) after it: "23,60" =
 *  "23.6", and "10,5 barg" = "10.5 BARG". "1,250" stays as it is, never 1.25.
 *
 *  A cell that is one number is compared as a number ("23.60" = "23.6"),
 *  but only with 15 significant digits or fewer. Past that, `Number` rounds,
 *  and two numbers that differ would compare equal; such a cell stays text. */
export function canonicalCell(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  let s = canonicalText(String(raw)).replace(/\s*\/\s*/g, '/');
  if (s.split(',').length === 2) s = s.replace(/(\d),(\d{1,2})(?!\d)/, '$1.$2');
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) {
    const [int = '', frac = ''] = s.replace(/^[-+]/, '').split('.');
    const digits = int.replace(/^0+/, '').length + frac.replace(/0+$/, '').length;
    if (digits <= 15) return String(Number(s));
  }
  return s;
}

/** The non-empty values the candidate rows give for one field. */
function given(values: string[]): Set<string> {
  return new Set(values.filter(Boolean));
}

/** Exact: at least one row gives the field, and every row that does gives `want`. */
function exact(values: string[], want: string): boolean {
  const g = given(values);
  return g.size === 1 && g.has(want);
}

export function score(input: ScoreInput): ScoreResult {
  const strip = input.stripLeadingZeros ?? true;
  // Truth rows by canonical tag. Rows that fall on one tag are all kept, so
  // the score does not depend on which came first (see the field loop).
  const truth = new Map<string, TruthRow[]>();
  const collided = new Set<string>();
  let truthCollisions = 0;
  let emptyTruth = 0;
  for (const row of input.truth) {
    const t = canonicalTag(row.tag, strip);
    const rows = truth.get(t);
    if (!t) emptyTruth++;
    else if (rows) {
      truthCollisions++;
      collided.add(t);
      rows.push(row);
    } else truth.set(t, [row]);
  }
  const found = new Map<string, Candidate[]>();
  let emptyCandidates = 0;
  for (const c of input.candidates) {
    const t = canonicalTag(c.tag, strip);
    if (!t) {
      emptyCandidates++;
      continue;
    }
    const list = found.get(t);
    if (list) list.push(c);
    else found.set(t, [c]);
  }

  const units = new Set(
    (input.units ?? [...truth.keys()].map(unitOf))
      .map((u) => canonicalTag(u, strip))
      .filter(Boolean),
  );

  let matched = 0;
  let serviceN = 0;
  let serviceOf = 0;
  let cellN = 0;
  let cellOf = 0;
  const missed: string[] = [];
  for (const [tag, rows] of truth) {
    const cands = found.get(tag) ?? [];
    if (cands.length === 0) {
      missed.push(tag);
    } else {
      matched++;
    }
    // Service and cells are scored over every truth field that is given: a
    // missed tag counts as a wrong service and wrong cells. Where truth rows
    // of one tag give different values, the field counts and is never right.
    const want = given(rows.map((r) => canonicalText(r.service ?? '')));
    if (want.size > 0) {
      serviceOf++;
      const got = cands.map((c) => canonicalText(c.service ?? ''));
      if (want.size === 1 && exact(got, [...want][0]!)) serviceN++;
    }
    for (const key of new Set(rows.flatMap((r) => Object.keys(r.conditions ?? {})))) {
      const w = given(rows.map((r) => canonicalCell(r.conditions?.[key])));
      if (w.size === 0) continue;
      cellOf++;
      const got = cands.map((c) => canonicalCell(c.conditions?.[key]));
      if (w.size === 1 && exact(got, [...w][0]!)) cellN++;
    }
  }

  const extra: string[] = [];
  const foreign: string[] = [];
  const conflicts: string[] = [];
  for (const [tag, cands] of found) {
    if (!truth.has(tag)) extra.push(tag);
    const unit = unitOf(tag);
    // A tag with no dash has no unit: it is foreign only when the truth
    // does not hold it.
    if (!units.has(unit) && !(unit === '' && truth.has(tag))) foreign.push(tag);
    const keys = new Set(cands.flatMap((c) => Object.keys(c.conditions ?? {})));
    const disagree =
      given(cands.map((c) => canonicalText(c.service ?? ''))).size > 1 ||
      [...keys].some((k) => given(cands.map((c) => canonicalCell(c.conditions?.[k]))).size > 1);
    if (disagree) conflicts.push(tag);
  }

  let accounting: ScoreResult['accounting'] = null;
  if (input.pages) {
    const listed = new Map<number, number>();
    for (const p of input.pages) listed.set(p.page, (listed.get(p.page) ?? 0) + 1);
    const perPage = new Map<number, number>();
    let unaccounted = 0;
    for (const c of input.candidates) {
      if (typeof c.page === 'number' && listed.has(c.page)) {
        perPage.set(c.page, (perPage.get(c.page) ?? 0) + 1);
      } else unaccounted++;
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
      const bad = !counts.every(isCount) || listed.get(p.page)! > 1;
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
      unaccounted,
      ok: pagesOk === input.pages.length && unaccounted === 0,
    };
  }

  const result: ScoreResult = {
    tags: { truth: truth.size, found: found.size, matched },
    recall: ratio(matched, truth.size),
    precision: ratio(matched, found.size),
    serviceExact: ratio(serviceN, serviceOf),
    conditionCells: ratio(cellN, cellOf),
    foreignUnitTags: foreign.length,
    truthCollisions,
    conflicts: conflicts.length,
    emptyTags: { truth: emptyTruth, candidates: emptyCandidates },
    accounting,
    options: { stripLeadingZeros: strip, units: input.units ? 'given' : 'from_truth' },
  };
  if (input.detail) {
    result.detail = {
      missed: missed.sort(),
      extra: extra.sort(),
      foreign: foreign.sort(),
      truthCollisions: [...collided].sort(),
      conflicts: conflicts.sort(),
    };
  }
  return result;
}
