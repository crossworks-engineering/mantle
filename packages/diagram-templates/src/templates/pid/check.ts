/**
 * The image check's marks in `pid` data (DWG bones phase 6): what a traced
 * drawing says about each guess it draws, and the count of guesses no
 * image has checked yet. Data only: the template never draws from these
 * fields by itself (old drawings render byte for byte as before); the view
 * reads them to show evidence and the "N guesses not checked by image"
 * note.
 *
 *   check (on an off-page connector, or a line's inline item), and
 *   checks (a list of them, on a line: one per inferred join its note counts):
 *     { key, kind, state, guess?, question?, answer?, alt?, reason?, model?,
 *       checkedAt?, crops?, overview? }
 *   checks (on the drawing, a set, or a set's page), the summary:
 *     { guesses, unchecked, checked, unsure, contradicted, corrected }
 *
 * `key` names one guess (circuit_trace writes a short hash of the drawing
 * table and the guess's check key): the same guess drawn on two pages of a
 * set is counted once. `state`:
 *   - unchecked: a guess no image has answered;
 *   - checked: the image said yes (CHECKED BY IMAGE, never certain);
 *   - unsure: the image could not tell (still a guess);
 *   - contradicted: the image said no, with no usable alternative (still a
 *     guess, IMAGE: NO);
 *   - corrected: the image said no and named what it is instead (`alt`):
 *     the drawing shows the alternative, labelled FROM IMAGE, never certain;
 *     `guess` keeps what the geometry read.
 * `crops` and `overview` are file ids of the stored crop images (the
 * evidence in the drawing table's Checks tab).
 *
 * Sealed marks (phase 6): a Write user or a client could type
 * `state: "checked"` with made-up evidence, or drop every mark so no "not
 * checked" note shows. So circuit_trace signs what it draws: each mark
 * carries `sig`, an HMAC over `markSealBody`, and the drawing (a set: the
 * set) carries `provenance` { id, keys, sig }: the keys of every guess the
 * trace drew (and the ones a cap left off), sealed with `provenanceSealBody`.
 * The key is the drawing check seal's (the brain's master key, HKDF, the
 * same key path as the Checks tab's rows); this package never holds it.
 * Every save normalizes the data (`honestImageChecks`, with a verifier the
 * content layer passes): without a valid provenance every mark is
 * `unchecked` with no evidence (a hand-written drawing never shows a check
 * it did not get); with one, a mark whose seal does not hold where it sits
 * is made `unchecked` with its evidence stripped, and a guess key with no mark
 * still counts, as unchecked (`imageCheckSummary`). The stored data is
 * then honest, and the view trusts it without verifying anything.
 *
 * The far end of a corrected sheet link shows the asked end's state
 * (corrected) without `alt`: the alternative names where the ASKED end
 * continues, nothing about the far one (its words are GUESS, IMAGE: NO:
 * it is drawn as first guessed).
 *
 * The trust words (MARK_WORDS: GUESS, CHECKED BY IMAGE, IMAGE: NO, FROM
 * IMAGE) are never part of a label's text: a label is text anyone with
 * Write may type. The view draws them from the mark (`markSuffix` after a
 * connector's text, `lineNoteSuffix` after a line's note), and a save
 * strips them from every label (`withoutMarkWords`), so a word on the
 * drawing is always the mark's. A mark's seal covers the element it sits
 * on (`markSite`: the page, its ids, ends, link and label, and on a line
 * the ordered keys of every mark the line carries), so a sealed mark copied
 * onto another element, kept under a changed label, or left on a line one
 * of whose other marks was dropped or swapped, is made unchecked. The
 * provenance's seal covers the drawing's title and sheet, so renaming a
 * traced drawing (or re-numbering its sheet) makes every mark unchecked
 * until it is traced again.
 *
 * What this vouches for (the threat model). A canvas's frame content is
 * author-controlled: anyone with Write can draw any picture, fake "CHECKED
 * BY IMAGE" text in their own SVG or script included, and no attempt is
 * made to sanitise arbitrary HTML. The guarantees are: (a) the canonical
 * template path (the data block and the shipped runtime, exactly as
 * buildCanvas emits them, which every save of a canvas claiming the `pid`
 * template is held to) never shows an unsealed check or a trust word that
 * is not the mark's; (b) no agent or tool can mark a guess checked without
 * a real image check (circuit_verify's sealed rows, circuit_trace's seals);
 * (c) the sealed Checks tab of the drawing's table is the record of proof.
 *
 * Removing a mark by hand also removes the GUESS word the view drew for
 * it, while the count still shows the guess unchecked (the provenance
 * lists it): the drawing says fewer words, never a stronger one.
 */
import {
  checkKeys,
  isObj,
  number,
  oneOf,
  str,
  type Issues,
  type Obj,
} from '../../runtime/validate.ts';

export const CHECK_STATES = [
  'unchecked',
  'checked',
  'unsure',
  'contradicted',
  'corrected',
] as const;
export type CheckState = (typeof CHECK_STATES)[number];
export const CHECK_GUESS_KINDS = ['join', 'end', 'link', 'valve'] as const;
export type CheckGuessKind = (typeof CHECK_GUESS_KINDS)[number];
export const CHECK_ANSWERS = ['yes', 'no', 'unsure'] as const;

/** One guess's image check, as a drawn element carries it. */
export type PidCheck = {
  key: string;
  kind: CheckGuessKind;
  state: CheckState;
  /** What the trace read from the geometry (kept when the image corrects it). */
  guess?: string;
  question?: string;
  answer?: (typeof CHECK_ANSWERS)[number];
  /** What the image says it is instead (a valve type, an equipment tag, a
   *  break), when its answer was no. */
  alt?: string;
  reason?: string;
  model?: string;
  checkedAt?: string;
  /** File ids of the crops the model saw, and of the sheet overview. */
  crops?: string[];
  overview?: string;
  /** circuit_trace's seal of the mark (`markSealBody`); a save drops a mark
   *  whose seal does not hold to `unchecked`. */
  sig?: string;
};

/** Which guesses a traced drawing (a set: the whole set) draws, sealed:
 *  `keys` lists every guess the trace drew, the ones a cap left off too, so
 *  a dropped mark still counts as unchecked. */
export type PidProvenance = { id: string; keys: string[]; sig: string };

/** The count of a drawing's guesses by their check state. */
export type PidChecksSummary = {
  guesses: number;
  unchecked: number;
  checked: number;
  unsure: number;
  contradicted: number;
  corrected: number;
};

export const CHECK_LIMITS = {
  key: 64,
  guess: 200,
  question: 600,
  alt: 40,
  reason: 300,
  model: 120,
  checkedAt: 40,
  crops: 8,
  fileId: 64,
  /** Most guess keys a provenance lists. */
  provenanceKeys: 4000,
} as const;

const CHECK_KEYS = [
  'key',
  'kind',
  'state',
  'guess',
  'question',
  'answer',
  'alt',
  'reason',
  'model',
  'checkedAt',
  'crops',
  'overview',
  'sig',
];
const SUMMARY_KEYS = ['guesses', 'unchecked', 'checked', 'unsure', 'contradicted', 'corrected'];
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A seal: an HMAC-SHA256, hex. */
const SIG = /^[0-9a-f]{64}$/;
/** A provenance id: random hex. */
const PROVENANCE_ID = /^[0-9a-f]{16,32}$/;

/** An element's `check`, read: undefined when absent or unusable (its
 *  problems are errors on `issues`). */
export function checkOf(
  o: Obj,
  path: string,
  issues: Issues,
  /** The path to name in errors, when not `<path>.check`. */
  named?: string,
): PidCheck | undefined {
  if (o.check === undefined) return undefined;
  const p = named ?? `${path}.check`;
  if (!isObj(o.check)) {
    issues.errors.push(
      `${p}: must be { key, kind, state, ... }, the image check of the guess this element draws (circuit_trace writes it).`,
    );
    return undefined;
  }
  const c = o.check;
  checkKeys(c, CHECK_KEYS, p, issues);
  const key = str(c, 'key', p, issues, { required: true, max: CHECK_LIMITS.key });
  const kind = oneOf(c, 'kind', CHECK_GUESS_KINDS, p, issues);
  const state = oneOf(c, 'state', CHECK_STATES, p, issues);
  if (c.kind === undefined)
    issues.errors.push(`${p}.kind: required, one of ${CHECK_GUESS_KINDS.join(', ')}.`);
  if (c.state === undefined)
    issues.errors.push(`${p}.state: required, one of ${CHECK_STATES.join(', ')}.`);
  const guess = str(c, 'guess', p, issues, { max: CHECK_LIMITS.guess });
  const question = str(c, 'question', p, issues, { max: CHECK_LIMITS.question });
  const answer = oneOf(c, 'answer', CHECK_ANSWERS, p, issues);
  const alt = str(c, 'alt', p, issues, { max: CHECK_LIMITS.alt });
  const reason = str(c, 'reason', p, issues, { max: CHECK_LIMITS.reason });
  const model = str(c, 'model', p, issues, { max: CHECK_LIMITS.model });
  const checkedAt = str(c, 'checkedAt', p, issues, { max: CHECK_LIMITS.checkedAt });
  const overview = str(c, 'overview', p, issues, {
    max: CHECK_LIMITS.fileId,
    pattern: FILE_ID,
    patternText: 'a file id',
  });
  const sig = str(c, 'sig', p, issues, { max: 64, pattern: SIG, patternText: 'a seal' });
  let crops: string[] | undefined;
  if (c.crops !== undefined) {
    if (
      !Array.isArray(c.crops) ||
      c.crops.length > CHECK_LIMITS.crops ||
      !c.crops.every((x) => typeof x === 'string' && FILE_ID.test(x))
    )
      issues.errors.push(`${p}.crops: at most ${CHECK_LIMITS.crops} file ids of the crops.`);
    else crops = [...(c.crops as string[])];
  }
  // A corrected guess names what the image says it is instead (`alt`),
  // except at the far end of a corrected sheet link, which shows the asked
  // end's state without it (see the header).
  if (state && state !== 'unchecked' && !answer)
    issues.errors.push(
      `${p}.answer: a ${state} guess carries the image's answer (yes, no, unsure).`,
    );
  if (!key || !kind || !state) return undefined;
  return {
    key,
    kind,
    state,
    ...(guess ? { guess } : {}),
    ...(question ? { question } : {}),
    ...(answer ? { answer } : {}),
    ...(alt ? { alt } : {}),
    ...(reason ? { reason } : {}),
    ...(model ? { model } : {}),
    ...(checkedAt ? { checkedAt } : {}),
    ...(crops?.length ? { crops } : {}),
    ...(overview ? { overview } : {}),
    ...(sig ? { sig } : {}),
  };
}

/** A drawing's (or a set's) `provenance`, read: undefined when absent or
 *  unusable (its problems are errors on `issues`). Its seal is checked on
 *  save (`honestImageChecks`), never here. */
export function provenanceOf(d: Obj, path: string, issues: Issues): PidProvenance | undefined {
  if (d.provenance === undefined) return undefined;
  const p = path ? `${path}.provenance` : 'provenance';
  const v = d.provenance;
  if (
    !isObj(v) ||
    typeof v.id !== 'string' ||
    !PROVENANCE_ID.test(v.id) ||
    typeof v.sig !== 'string' ||
    !SIG.test(v.sig) ||
    !Array.isArray(v.keys) ||
    v.keys.length > CHECK_LIMITS.provenanceKeys ||
    !v.keys.every((k) => typeof k === 'string' && k.length > 0 && k.length <= CHECK_LIMITS.key)
  ) {
    issues.errors.push(
      `${p}: must be { id, keys, sig } as circuit_trace writes it (the guesses it drew, sealed); keep it unchanged or leave it out.`,
    );
    return undefined;
  }
  checkKeys(v, ['id', 'keys', 'sig'], p, issues);
  return { id: v.id, keys: [...(v.keys as string[])], sig: v.sig };
}

/** Most checks a line carries (one per inferred join its note counts). */
export const LINE_CHECKS_MAX = 24;

/** A line's `checks`: one per inferred join, each read as `checkOf`. */
export function checkListOf(o: Obj, path: string, issues: Issues): PidCheck[] | undefined {
  if (o.checks === undefined) return undefined;
  const p = `${path}.checks`;
  if (!Array.isArray(o.checks) || o.checks.length > LINE_CHECKS_MAX) {
    issues.errors.push(
      `${p}: a list of at most ${LINE_CHECKS_MAX} image checks, one per inferred join on the line (circuit_trace writes it).`,
    );
    return undefined;
  }
  const out: PidCheck[] = [];
  o.checks.forEach((c, i) => {
    const one = checkOf({ check: c }, p, issues, `${p}[${i}]`);
    if (one) out.push(one);
  });
  return out.length ? out : undefined;
}

/** A drawing's (or a set's) `checks` summary, read. */
export function checksSummaryOf(
  d: Obj,
  path: string,
  issues: Issues,
): PidChecksSummary | undefined {
  if (d.checks === undefined) return undefined;
  const p = path ? `${path}.checks` : 'checks';
  if (!isObj(d.checks)) {
    issues.errors.push(
      `${p}: must be { guesses, unchecked, checked, unsure, contradicted, corrected }, counts of the image check (circuit_trace and present_create write it).`,
    );
    return undefined;
  }
  checkKeys(d.checks, SUMMARY_KEYS, p, issues);
  const out = {} as PidChecksSummary;
  for (const k of SUMMARY_KEYS as (keyof PidChecksSummary)[]) {
    const n = number(d.checks, k, p, issues, { min: 0, max: 100000 }) ?? 0;
    if (!Number.isInteger(n)) issues.errors.push(`${p}.${k}: a whole number.`);
    out[k] = n;
  }
  return out;
}

/**
 * Each drawing of raw `pid` data passed through `fn`: a set's pages (with
 * the page's id), else the data itself (page null). The one walker of a
 * drawing or a set (sealing, counting, normalizing and stripping words all
 * go through it). The same object comes back when `fn` changed nothing;
 * a page that is not an object with object `data` is left as it is.
 */
export function mapDrawings<T>(data: T, fn: (drawing: Obj, page: string | null) => Obj): T {
  if (!isObj(data)) return data;
  if (!Array.isArray(data.pages)) return fn(data, null) as T;
  const pages = data.pages.map((pg) => {
    if (!isObj(pg) || !isObj(pg.data)) return pg;
    const next = fn(pg.data, typeof pg.id === 'string' ? pg.id : null);
    return next === pg.data ? pg : { ...pg, data: next };
  });
  return (
    pages.some((p, i) => p !== (data.pages as unknown[])[i]) ? { ...data, pages } : data
  ) as T;
}

/** Every `check` an element of one drawing's raw data carries: its
 *  connectors, its lines and their inline items. Raw (unvalidated) data
 *  is read loosely: anything without a key, kind and state is skipped. */
function checksIn(d: unknown): Pick<PidCheck, 'key' | 'state'>[] {
  if (!isObj(d)) return [];
  const out: Pick<PidCheck, 'key' | 'state'>[] = [];
  const take = (o: unknown) => {
    if (!isObj(o) || !isObj(o.check)) return;
    const { key, state } = o.check;
    if (typeof key !== 'string' || !key) return;
    if (!(CHECK_STATES as readonly unknown[]).includes(state)) return;
    out.push({ key, state: state as CheckState });
  };
  for (const o of Array.isArray(d.offpage) ? d.offpage : []) take(o);
  for (const l of Array.isArray(d.lines) ? d.lines : []) {
    if (!isObj(l)) continue;
    for (const c of Array.isArray(l.checks) ? l.checks : []) take({ check: c });
    for (const it of Array.isArray(l.inline) ? l.inline : []) take(it);
  }
  return out;
}

/** The guess keys a drawing's `provenance` lists, read loosely. */
function provenanceKeys(d: Obj): string[] {
  const p = d.provenance;
  if (!isObj(p) || !Array.isArray(p.keys)) return [];
  return p.keys.filter((k): k is string => typeof k === 'string' && k.length > 0);
}

/** The weakest state wins when one guess is drawn twice with two states
 *  (an edited copy): unchecked before anything answered. */
const RANK: Readonly<Record<CheckState, number>> = {
  unchecked: 0,
  contradicted: 1,
  unsure: 2,
  corrected: 3,
  checked: 4,
};

/** The weakest state of one item's checks (a line's joins): what its one
 *  colour and badge show. */
export function weakestState(checks: readonly { state: CheckState }[]): CheckState {
  return checks.reduce<CheckState>((w, c) => (RANK[c.state] < RANK[w] ? c.state : w), 'checked');
}

/**
 * The image check counts of `pid` data (one drawing, or a set: every page,
 * each guess once by its key), counted from the elements' own `check`
 * marks, never from a `checks` field the data carries. Null when nothing
 * on it carries a check (a drawing not made by circuit_trace).
 */
export function imageCheckSummary(data: unknown): PidChecksSummary | null {
  if (!isObj(data)) return null;
  const byKey = new Map<string, CheckState>();
  mapDrawings(data, (d) => {
    for (const c of checksIn(d)) {
      const had = byKey.get(c.key);
      if (had === undefined || RANK[c.state] < RANK[had]) byKey.set(c.key, c.state);
    }
    return d;
  });
  // A guess the trace drew whose mark is gone (dropped by hand, or cut by a
  // cap) is still a guess: unchecked. The provenance is the stored one,
  // honest once a save normalized it (honestImageChecks).
  for (const k of provenanceKeys(data)) if (!byKey.has(k)) byKey.set(k, 'unchecked');
  if (!byKey.size) return null;
  const out: PidChecksSummary = {
    guesses: byKey.size,
    unchecked: 0,
    checked: 0,
    unsure: 0,
    contradicted: 0,
    corrected: 0,
  };
  for (const s of byKey.values()) out[s] += 1;
  return out;
}

/** The data with its `checks` summary (and each set page's) recounted from
 *  its elements: what circuit_trace and present_create store, so the count
 *  the view shows is the drawing's own, whatever the author passed. Data
 *  with no check marks comes back as it was, minus a stale `checks`. */
export function withImageCheckSummary<T>(data: T): T {
  if (!isObj(data)) return data;
  const { checks: _drop, ...rest } = data;
  const total = imageCheckSummary(data);
  const pages = Array.isArray(rest.pages)
    ? rest.pages.map((p) => {
        if (!isObj(p) || !isObj(p.data)) return p;
        const { checks: _old, ...pd } = p.data;
        const here = imageCheckSummary(pd);
        return { ...p, data: here ? { ...pd, checks: here } : pd };
      })
    : undefined;
  return {
    ...rest,
    ...(pages ? { pages } : {}),
    ...(total ? { checks: total } : {}),
  } as T;
}

/** Whether the data's `checks` (or a set page's) differs from the count of
 *  its own marks: a hand edit, a pasted source or an old revision may carry
 *  a count its marks do not. */
export function imageChecksStale(data: unknown): boolean {
  if (!isObj(data)) return false;
  const same = (stored: unknown, own: PidChecksSummary | null): boolean =>
    own === null
      ? stored === undefined
      : isObj(stored) &&
        Object.keys(stored).length === SUMMARY_KEYS.length &&
        SUMMARY_KEYS.every((k) => stored[k] === own[k as keyof PidChecksSummary]);
  if (!same(data.checks, imageCheckSummary(data))) return true;
  if (Array.isArray(data.pages))
    for (const p of data.pages)
      if (isObj(p) && isObj(p.data) && !same(p.data.checks, imageCheckSummary(p.data))) return true;
  return false;
}

// ------------------------------------------------------------- the words

/** The trust words, the one list (the view draws them, circuit_trace
 *  writes them only where an element carries no mark, a save strips them
 *  from every label): a guess no image confirmed is a GUESS; one it saw
 *  is CHECKED BY IMAGE, never certain; IMAGE: NO when it said no; FROM
 *  IMAGE when the drawing shows what it named instead. */
export const MARK_WORDS = {
  guess: 'GUESS',
  checked: 'CHECKED BY IMAGE',
  no: 'IMAGE: NO',
  image: 'FROM IMAGE',
} as const;

/** What the view draws after a marked element's label (a connector's
 *  text), by its mark: unchecked and unsure ` (GUESS)`, checked ` (CHECKED
 *  BY IMAGE)`, contradicted ` (GUESS, IMAGE: NO)`, corrected ` (FROM
 *  IMAGE)` when the mark names its alternative (`alt`: the element is
 *  drawn as the image named it), else ` (GUESS, IMAGE: NO)` (the far end
 *  of a corrected sheet link, drawn as first guessed). */
export function markSuffix(mark: CheckState | { state?: unknown; alt?: unknown }): string {
  const state = typeof mark === 'string' ? mark : mark.state;
  const named = typeof mark === 'string' || (typeof mark.alt === 'string' && mark.alt !== '');
  switch (state) {
    case 'checked':
      return ` (${MARK_WORDS.checked})`;
    case 'corrected':
      return named ? ` (${MARK_WORDS.image})` : ` (${MARK_WORDS.guess}, ${MARK_WORDS.no})`;
    case 'contradicted':
      return ` (${MARK_WORDS.guess}, ${MARK_WORDS.no})`;
    default:
      return ` (${MARK_WORDS.guess})`;
  }
}

const stateOf = (c: unknown): CheckState | undefined =>
  isObj(c) && (CHECK_STATES as readonly unknown[]).includes(c.state)
    ? (c.state as CheckState)
    : undefined;

/**
 * What the view draws after a line's note (or alone, when the line has
 * marks and no note), from the marks the line carries: its inferred
 * joins' (`checks`) when it has any, else its inline valves' (an inline
 * item's `check` of kind valve). Joins: all checked ` (CHECKED BY
 * IMAGE)`; one open and it contradicted ` (GUESS, IMAGE: NO)`; several
 * open, n contradicted ` (GUESS; IMAGE: n NO)`; else ` (GUESS)`. Valves
 * (only answered ones are said): any contradicted ` (GUESS, IMAGE: NO)`,
 * else any corrected ` (FROM IMAGE)`, else any checked ` (CHECKED BY
 * IMAGE)`, else nothing. '' when the line carries no such mark.
 */
export function lineNoteSuffix(line: unknown): string {
  if (!isObj(line)) return '';
  const joins = (Array.isArray(line.checks) ? line.checks : [])
    .map(stateOf)
    .filter((s): s is CheckState => !!s);
  if (joins.length) {
    const open = joins.filter((s) => s !== 'checked').length;
    const no = joins.filter((s) => s === 'contradicted').length;
    if (!open) return ` (${MARK_WORDS.checked})`;
    if (!no) return ` (${MARK_WORDS.guess})`;
    return open === 1
      ? ` (${MARK_WORDS.guess}, ${MARK_WORDS.no})`
      : ` (${MARK_WORDS.guess}; IMAGE: ${no} NO)`;
  }
  const valves = (Array.isArray(line.inline) ? line.inline : [])
    .map((it) =>
      isObj(it) && isObj(it.check) && it.check.kind === 'valve' ? stateOf(it.check) : undefined,
    )
    .filter((s): s is CheckState => !!s);
  if (valves.includes('contradicted')) return ` (${MARK_WORDS.guess}, ${MARK_WORDS.no})`;
  if (valves.includes('corrected')) return ` (${MARK_WORDS.image})`;
  if (valves.includes('checked')) return ` (${MARK_WORDS.checked})`;
  return '';
}

/** The bracketed forms the view draws after a label (`markSuffix`,
 *  `lineNoteSuffix`), in any case (a label font may draw in capitals) and
 *  any spacing (a drawing collapses it): only these are stripped, never
 *  the same words in prose ("redrawn from image scan" stays). */
const SP = '\\s+';
const CLAIM_FORM = new RegExp(
  `\\s*\\(\\s*(?:CHECKED${SP}BY${SP}IMAGE|FROM${SP}IMAGE)\\s*\\)`,
  'gi',
);
const NO_FORM = /\s*\(\s*GUESS\s*[,;]\s*IMAGE\s*:\s*(?:\d+\s+)?NO\s*\)/gi;
const GUESS_FORM = /\s*\(\s*GUESS\s*\)/gi;

/** `s` with the forms `forms` match taken out, pass after pass until
 *  nothing changes (so a word hidden inside another, `(CHECKED BY (GUESS)
 *  IMAGE)`, never comes out whole). */
function stripForms(s: string, forms: readonly RegExp[]): string {
  let cur = s;
  for (let i = 0; i < 16; i += 1) {
    const next = forms.reduce((t, f) => t.replace(f, ''), cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}
const ALL_FORMS = [GUESS_FORM, NO_FORM, CLAIM_FORM] as const;

/**
 * A label without the view's bracketed trust words. On a marked element
 * every form goes, ` (GUESS)` too (the view draws the mark's own). On an
 * element with no mark (`marked` false), a label that holds a form claiming
 * an image check (` (CHECKED BY IMAGE)`, ` (FROM IMAGE)`, ` (GUESS, IMAGE:
 * NO)`, hidden inside another or not) loses every form and ends in one
 * ` (GUESS)`: GUESS claims no check, and the element is still a guess (a
 * drawing traced before the marks wrote its words into the label; without
 * a word it would read as fact). A label with only ` (GUESS)` keeps it as
 * written. The same string when it holds no claim.
 */
function withoutWords(s: string, marked: boolean): string {
  const bare = stripForms(s, ALL_FORMS);
  if (marked) return bare === s ? s : bare.trim();
  // Only GUESS forms in it: no claim, nothing to change.
  if (bare === stripForms(s, [GUESS_FORM])) return s;
  return `${bare.trim()} (${MARK_WORDS.guess})`.trim();
}

/** Keys whose values are no label: the marks themselves, the seals, the
 *  counts, the site profile and the prose description (which explains the
 *  words). */
const NOT_LABELS = new Set(['check', 'checks', 'provenance', 'profile', 'description']);

/** Every label string of `v` passed through `fn`, structure shared where
 *  nothing changed. */
function mapLabels(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) {
    const out = v.map((x) => mapLabels(x, fn));
    return out.some((x, i) => x !== v[i]) ? out : v;
  }
  if (!isObj(v)) return v;
  let out: Obj | null = null;
  for (const [k, x] of Object.entries(v)) {
    if (NOT_LABELS.has(k)) continue;
    const y = mapLabels(x, fn);
    if (y !== x) (out ??= { ...v })[k] = y;
  }
  return out ?? v;
}

/**
 * `pid` data (a drawing or a set) with no trust word typed into a label:
 * the bracketed forms the view draws that claim an image check (`(CHECKED
 * BY IMAGE)`, `(FROM IMAGE)`, `(GUESS, IMAGE: NO)`, `(GUESS; IMAGE: n NO)`)
 * are stripped from every label, ids and references alike (one function
 * of the text, so a reference still names its element), each leaving
 * ` (GUESS)`; on an element that carries a mark (a connector's
 * text, an inline item's tag, the note of a line with marks) ` (GUESS)`
 * goes too, since the view draws the mark's word. GUESS stays on an
 * element with no mark: it claims no check, and a drawing traced before
 * the marks has no other. The prose description is not a label and keeps
 * its words, and so do words outside the view's brackets. The same object
 * comes back when nothing changed. Limit: text that only looks like a
 * word (a letter from another script) is not caught; the view draws the
 * real words in a style of their own.
 */
export function withoutMarkWords<T>(data: T): T {
  if (!isObj(data)) return data;
  const claims = mapLabels(data, (s) => withoutWords(s, false)) as Obj;
  const guessless = (o: Obj, k: string): Obj => {
    if (typeof o[k] !== 'string') return o;
    const next = withoutWords(o[k] as string, true);
    return next === o[k] ? o : { ...o, [k]: next };
  };
  const mapList = (v: unknown, f: (x: Obj) => Obj): unknown => {
    if (!Array.isArray(v)) return v;
    const out = v.map((x) => (isObj(x) ? f(x) : x));
    return out.some((x, i) => x !== v[i]) ? out : v;
  };
  return mapDrawings(claims, (d) => {
    const offpage = mapList(d.offpage, (o) => (o.check !== undefined ? guessless(o, 'text') : o));
    const lines = mapList(d.lines, (l) => {
      const inline = mapList(l.inline, (it) =>
        it.check !== undefined ? guessless(it, 'tag') : it,
      );
      const marked =
        (Array.isArray(l.checks) && l.checks.length > 0) ||
        (Array.isArray(inline) && inline.some((it) => isObj(it) && it.check !== undefined));
      const next = inline === l.inline ? l : { ...l, inline };
      return marked ? guessless(next, 'note') : next;
    });
    return offpage === d.offpage && lines === d.lines ? d : { ...d, offpage, lines };
  }) as T;
}

// ------------------------------------------------------------- the seals

/**
 * Where a mark sits, as its seal covers it: the page of a set it is on
 * (null on one drawing); a connector's id, direction, sheet, text and page
 * link; a line's id, line number, ends and note, and the ordered keys of
 * every mark the line carries (its inferred joins' `checks`, then its
 * marked inline items'), so dropping, swapping or copying one of a line's
 * marks unseals the others; and for an inline item, the line's and the
 * item's place, type and tag. A sealed mark copied onto another element, or
 * left under a label changed since (the view draws the mark's word after
 * it), no longer holds. Raw values.
 */
export type MarkSite = readonly unknown[];
const raw = (x: unknown) => (x === undefined ? null : x);
/** The keys of a line's marks, in order: joins, then marked inline items. */
function lineMarkKeys(l: Obj): unknown[] {
  const key = (c: unknown) => (isObj(c) ? raw(c.key) : null);
  return [
    ...(Array.isArray(l.checks) ? l.checks.map(key) : []),
    ...(Array.isArray(l.inline) ? l.inline : [])
      .filter((it) => isObj(it) && it.check !== undefined)
      .map((it) => key((it as Obj).check)),
  ];
}
function lineSite(l: Obj): unknown[] {
  return [raw(l.id), raw(l.number), raw(l.from), raw(l.to), raw(l.note), lineMarkKeys(l)];
}
export function markSite(
  where: { offpage: Obj } | { line: Obj } | { line: Obj; inline: Obj; index: number },
  page: string | null = null,
): MarkSite {
  if ('offpage' in where) {
    const o = where.offpage;
    return ['offpage', page, raw(o.id), raw(o.direction), raw(o.sheet), raw(o.text), raw(o.link)];
  }
  if ('inline' in where) {
    const it = where.inline;
    return ['inline', page, ...lineSite(where.line), where.index, raw(it.type), raw(it.tag)];
  }
  return ['line', page, ...lineSite(where.line)];
}

/** What circuit_trace seals of one mark: every field the view shows, under
 *  the provenance it was drawn with (a mark cannot move to another trace's
 *  drawing) and on the element it sits on (`markSite`: nor to another
 *  element). Raw values, so a changed type breaks the seal too. */
export function markSealBody(provenanceId: string, c: Obj, site?: MarkSite): string {
  return JSON.stringify([
    'pid-check v3',
    provenanceId,
    site ?? null,
    ...CHECK_KEYS.filter((k) => k !== 'sig').map((k) => c[k] ?? null),
  ]);
}

/** What circuit_trace seals of a drawing's provenance (a set: the set's),
 *  with the drawing's (or set's) title and sheet, so a renamed or
 *  re-numbered drawing no longer vouches for its marks. Raw values; the
 *  labels as a save stores them (`withoutMarkWords`). */
export function provenanceSealBody(
  p: Pick<PidProvenance, 'id' | 'keys'>,
  drawing: unknown,
): string {
  const d = isObj(drawing) ? drawing : {};
  return JSON.stringify(['pid-provenance v2', p.id, p.keys, raw(d.title), raw(d.sheet)]);
}

/** Whether `sig` is the brain's seal of `body` (the content layer passes
 *  it; this package holds no key). */
export type SealCheck = (body: string, sig: string) => boolean;

/** One drawing's raw data with each mark passed through `fn`, with where
 *  it sits (`markSite`, on `page` of a set; null for one drawing): its
 *  connectors', its lines' and their inline items'. The same object comes
 *  back when `fn` changed nothing (so an honest canvas stays byte for
 *  byte); raw data is walked loosely. */
export function mapImageChecks(
  d: Obj,
  fn: (mark: unknown, site: MarkSite) => unknown,
  page: string | null = null,
): Obj {
  const mapList = (val: unknown, f: (x: unknown, i: number) => unknown): unknown => {
    if (!Array.isArray(val)) return val;
    const out = val.map(f);
    return out.some((x, i) => x !== val[i]) ? out : val;
  };
  const offpage = mapList(d.offpage, (o) => {
    if (!isObj(o) || o.check === undefined) return o;
    const next = fn(o.check, markSite({ offpage: o }, page));
    return next === o.check ? o : { ...o, check: next };
  });
  const lines = mapList(d.lines, (l) => {
    if (!isObj(l)) return l;
    // Every site on the line is read off the line as it came in: a mark's
    // seal covers its siblings' keys as drawn, not as `fn` left them.
    const checks = mapList(l.checks, (c) => fn(c, markSite({ line: l }, page)));
    const inline = mapList(l.inline, (it, index) => {
      if (!isObj(it) || it.check === undefined) return it;
      const next = fn(it.check, markSite({ line: l, inline: it, index }, page));
      return next === it.check ? it : { ...it, check: next };
    });
    return checks === l.checks && inline === l.inline ? l : { ...l, checks, inline };
  });
  return offpage === d.offpage && lines === d.lines ? d : { ...d, offpage, lines };
}

/**
 * `pid` data (a drawing or a set) with every mark sealed (`sig`) under
 * `provenanceId` where it sits, by `sign` (the content layer's seal; this
 * package holds no key). circuit_trace's one sealing path
 * (@mantle/tools check-seal.ts sealedPid), so the site a save checks is
 * the site that was sealed.
 */
export function signImageChecks<T>(
  data: T,
  provenanceId: string,
  sign: (body: string) => string,
): T {
  return mapDrawings(data, (d, page) =>
    mapImageChecks(
      d,
      (c, site) => (isObj(c) ? { ...c, sig: sign(markSealBody(provenanceId, c, site)) } : c),
      page,
    ),
  );
}

/** The fields of a mark that are evidence of an answer (all but what names
 *  the guess). */
const EVIDENCE = CHECK_KEYS.filter((k) => !['key', 'kind', 'state', 'guess'].includes(k));

/** A mark that claims nothing: unchecked, the guess only. */
function unclaimed(c: Obj): Obj {
  return {
    ...(c.key !== undefined ? { key: c.key } : {}),
    ...(c.kind !== undefined ? { kind: c.kind } : {}),
    state: 'unchecked',
    ...(c.guess !== undefined ? { guess: c.guess } : {}),
  };
}

/**
 * The data as a save stores it (`pid` data, one drawing or a set): no
 * trust word in a label (`withoutMarkWords`), its provenance kept only
 * when its seal holds (a set's on the set; one on a set's page is
 * dropped), and each mark kept only when it claims nothing (unchecked, no
 * evidence) or circuit_trace's seal of it holds under that provenance on
 * the element it sits on; any other mark becomes unchecked, its evidence
 * stripped. Without a provenance (a hand-written drawing) every mark is
 * unchecked. The same object comes back when nothing changed. The
 * `checks` counts are not touched (withImageCheckSummary).
 */
export function honestImageChecks<T>(given: T, holds: SealCheck): T {
  if (!isObj(given)) return given;
  const data = withoutMarkWords(given) as Obj;
  const p = data.provenance;
  let prov: { id: string } | null = null;
  if (p !== undefined) {
    const issues: Issues = { errors: [], warnings: [] };
    const read = provenanceOf(data, '', issues);
    if (read && !issues.errors.length && holds(provenanceSealBody(read, data), read.sig))
      prov = { id: read.id };
  }
  // The seal covers the key and the provenance id: a sealed mark past the
  // provenance's key cap still holds (only its count needs the list).
  const fix = (c: unknown, site: MarkSite, alone: boolean): unknown => {
    if (!isObj(c)) return c;
    if (
      prov &&
      alone &&
      typeof c.key === 'string' &&
      typeof c.sig === 'string' &&
      SIG.test(c.sig) &&
      holds(markSealBody(prov.id, c, site), c.sig)
    )
      return c;
    if (c.state === 'unchecked' && !EVIDENCE.some((k) => c[k] !== undefined)) return c;
    return unclaimed(c);
  };
  let out: Obj = data;
  if (p !== undefined && !prov) {
    const { provenance: _drop, ...rest } = data;
    out = rest;
  }
  const set = Array.isArray(out.pages);
  return mapDrawings(out, (d, page) => {
    let pd = d;
    // A set's provenance is the set's: one on a page vouches for nothing.
    if (set && pd.provenance !== undefined) {
      const { provenance: _page, ...rest } = pd;
      pd = rest;
    }
    // A mark holds only on an element its id names alone: a connector or
    // a line copied with its marks (or one with no id) has the same site
    // as its original, so neither copy's marks hold.
    const shared = sharedIds(pd);
    return mapImageChecks(
      pd,
      (c, site) =>
        fix(
          c,
          site,
          typeof site[2] === 'string' && !shared.has(`${String(site[0] === 'offpage')}:${site[2]}`),
        ),
      page,
    );
  }) as T;
}

/** The ids more than one connector (`true:<id>`) or more than one line
 *  (`false:<id>`) of a drawing carries. */
function sharedIds(d: Obj): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  const count = (list: unknown, offpage: boolean) => {
    if (!Array.isArray(list)) return;
    for (const x of list) {
      if (!isObj(x) || typeof x.id !== 'string') continue;
      const k = `${String(offpage)}:${x.id}`;
      if (seen.has(k)) shared.add(k);
      else seen.add(k);
    }
  };
  count(d.offpage, true);
  count(d.lines, false);
  return shared;
}
