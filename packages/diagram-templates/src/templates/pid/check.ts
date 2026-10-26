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
 * it did not get); with one, a mark whose seal does not hold is made
 * `unchecked` with its evidence stripped, and a guess key with no mark
 * still counts, as unchecked (`imageCheckSummary`). The stored data is
 * then honest, and the view trusts it without verifying anything.
 *
 * The far end of a corrected sheet link shows the asked end's state
 * (corrected) without `alt`: the alternative names where the ASKED end
 * continues, nothing about the far one.
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

/**
 * The image check counts of `pid` data (one drawing, or a set: every page,
 * each guess once by its key), counted from the elements' own `check`
 * marks, never from a `checks` field the data carries. Null when nothing
 * on it carries a check (a drawing not made by circuit_trace).
 */
export function imageCheckSummary(data: unknown): PidChecksSummary | null {
  if (!isObj(data)) return null;
  const drawings = Array.isArray(data.pages)
    ? data.pages.map((p) => (isObj(p) ? p.data : undefined))
    : [data];
  const byKey = new Map<string, CheckState>();
  for (const d of drawings)
    for (const c of checksIn(d)) {
      const had = byKey.get(c.key);
      if (had === undefined || RANK[c.state] < RANK[had]) byKey.set(c.key, c.state);
    }
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

// ------------------------------------------------------------- the seals

/** What circuit_trace seals of one mark: every field the view shows, under
 *  the provenance it was drawn with (a mark cannot move to another trace's
 *  drawing). Raw values, so a changed type breaks the seal too. */
export function markSealBody(provenanceId: string, c: Obj): string {
  return JSON.stringify([
    'pid-check v1',
    provenanceId,
    ...CHECK_KEYS.filter((k) => k !== 'sig').map((k) => c[k] ?? null),
  ]);
}

/** What circuit_trace seals of a drawing's provenance. */
export function provenanceSealBody(p: Pick<PidProvenance, 'id' | 'keys'>): string {
  return JSON.stringify(['pid-provenance v1', p.id, p.keys]);
}

/** Whether `sig` is the brain's seal of `body` (the content layer passes
 *  it; this package holds no key). */
export type SealCheck = (body: string, sig: string) => boolean;

/** One drawing's raw data with each mark passed through `fn`: its
 *  connectors', its lines' and their inline items'. The same object comes
 *  back when `fn` changed nothing (so an honest canvas stays byte for
 *  byte); raw data is walked loosely. */
export function mapImageChecks(d: Obj, fn: (mark: unknown) => unknown): Obj {
  const mapList = (v: unknown, f: (x: unknown) => unknown): unknown => {
    if (!Array.isArray(v)) return v;
    const out = v.map(f);
    return out.some((x, i) => x !== v[i]) ? out : v;
  };
  const one = (o: unknown): unknown => {
    if (!isObj(o) || o.check === undefined) return o;
    const next = fn(o.check);
    return next === o.check ? o : { ...o, check: next };
  };
  const offpage = mapList(d.offpage, one);
  const lines = mapList(d.lines, (l) => {
    if (!isObj(l)) return l;
    const checks = mapList(l.checks, fn);
    const inline = mapList(l.inline, one);
    return checks === l.checks && inline === l.inline ? l : { ...l, checks, inline };
  });
  return offpage === d.offpage && lines === d.lines ? d : { ...d, offpage, lines };
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
 * The data as a save stores it (`pid` data, one drawing or a set): its
 * provenance kept only when its seal holds (a set's on the set; one on a
 * set's page is dropped), and each mark kept only when it claims nothing
 * (unchecked, no evidence) or circuit_trace's seal of it holds under that
 * provenance and names one of its keys; any other mark becomes unchecked,
 * its evidence stripped. Without a provenance (a hand-written drawing)
 * every mark is unchecked. The same object comes back when nothing
 * changed. The `checks` counts are not touched (withImageCheckSummary).
 */
export function honestImageChecks<T>(data: T, holds: SealCheck): T {
  if (!isObj(data)) return data;
  const p = data.provenance;
  let prov: { id: string; keys: Set<string> } | null = null;
  if (p !== undefined) {
    const issues: Issues = { errors: [], warnings: [] };
    const read = provenanceOf(data, '', issues);
    if (read && !issues.errors.length && holds(provenanceSealBody(read), read.sig))
      prov = { id: read.id, keys: new Set(read.keys) };
  }
  const fix = (c: unknown): unknown => {
    if (!isObj(c)) return c;
    if (
      prov &&
      typeof c.key === 'string' &&
      prov.keys.has(c.key) &&
      typeof c.sig === 'string' &&
      SIG.test(c.sig) &&
      holds(markSealBody(prov.id, c), c.sig)
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
  if (Array.isArray(out.pages)) {
    let any = false;
    const pages = out.pages.map((pg) => {
      if (!isObj(pg) || !isObj(pg.data)) return pg;
      let pd: Obj = pg.data;
      if (pd.provenance !== undefined) {
        const { provenance: _page, ...rest } = pd;
        pd = rest;
      }
      pd = mapImageChecks(pd, fix);
      if (pd === pg.data) return pg;
      any = true;
      return { ...pg, data: pd };
    });
    if (any) out = { ...out, pages };
  } else out = mapImageChecks(out, fix);
  return out as T;
}
