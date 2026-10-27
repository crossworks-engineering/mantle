/**
 * The bounds of raw `pid` data, checked before anything walks it (DWG bones
 * phase 6). A save normalizes a canvas's marks (check.ts
 * honestImageChecks) and the runtime does the same for data it cannot
 * vouch for (unvouched.ts); both read raw data, before the
 * template's check. So the sizes that check holds a drawing to are checked
 * first, cheaply, and data past one is refused whole (a save says why; the
 * runtime drops its marks): no normalizing pass ever runs on a label, a
 * list or a nesting larger than a drawing can hold.
 *
 * The template's own check runs this first (schema.ts validatePid, set.ts
 * validatePidSet) and refuses data past a bound whole, so the check, a
 * save's honest pass and the runtime agree, by construction, on which data
 * is too large: no drawing past a bound is drawn, stored or trusted.
 *
 * The bounds are the template's own (PID_LIMITS, SET_LIMITS, CHECK_LIMITS,
 * LINE_CHECKS_MAX), so no drawing within them is refused here; and,
 * for any field the template bounds only by what it must name, the largest
 * the template takes anywhere: a string of RAW_LIMITS.string characters
 * (a custom symbol's path data), a list or an object of RAW_LIMITS.list
 * items (a provenance's keys), a nesting RAW_LIMITS.depth deep.
 *
 * One walk over the data, linear in its size (the canvas is at most 1 MB).
 */
import { isObj, pathKey, type Obj } from '../../runtime/validate.ts';
import { PID_LIMITS, SET_LIMITS } from './sizes.ts';
import { CHECK_LIMITS, LINE_CHECKS_MAX } from './check.ts';

/** The bounds of any value in raw `pid` data the named limits leave open. */
export const RAW_LIMITS = {
  /** The longest string the template takes: a custom symbol's path data. */
  string: 2000,
  /** The most items of a list or members of an object: a provenance's keys. */
  list: CHECK_LIMITS.provenanceKeys,
  /** The deepest nesting: the template's deepest field (a set's page's
   *  inline mark's crops, a custom symbol's path) is under ten deep. */
  depth: 16,
} as const;

/** A tag (an inline item's), at most this long (schema.ts tagRule). */
const TAG_MAX = 32;

/** The string fields of one image check mark and their longest. */
const CHECK_TEXT: Readonly<Record<string, number>> = {
  key: CHECK_LIMITS.key,
  guess: CHECK_LIMITS.guess,
  question: CHECK_LIMITS.question,
  alt: CHECK_LIMITS.alt,
  reason: CHECK_LIMITS.reason,
  model: CHECK_LIMITS.model,
  checkedAt: CHECK_LIMITS.checkedAt,
  overview: CHECK_LIMITS.fileId,
  sig: 64,
};

/** The lists of one drawing and their most items. */
const DRAWING_LISTS: Readonly<Record<string, number>> = {
  equipment: PID_LIMITS.equipment,
  offpage: PID_LIMITS.offpage,
  lines: PID_LIMITS.lines,
  tees: PID_LIMITS.tees,
  instruments: PID_LIMITS.instruments,
  signals: PID_LIMITS.signals,
  circuits: PID_LIMITS.circuits,
};

/** The template's error for data past a bound (`problem`, by its path):
 *  the one error its check gives such data (schema.ts validatePid,
 *  set.ts validatePidSet run this check before any other). */
export function overLimitError(problem: string): string {
  return `data: larger than a P&ID drawing can hold (${problem}). Make it smaller: split it into pages, or shorten the text.`;
}

/**
 * Why raw `pid` data (one drawing or a set) is past a bound the template
 * holds it to, or null when it is within all of them. Only sizes: a value
 * of the wrong type, or one the template refuses for another reason, is
 * the template's check to report.
 */
export function pidLimitsProblem(data: unknown): string | null {
  return rawProblem(data) ?? namedProblem(data);
}

/** Any string, list, object or nesting past RAW_LIMITS, by its path. */
function rawProblem(data: unknown): string | null {
  const stack: [unknown, string, number][] = [[data, '', 0]];
  while (stack.length) {
    const [v, path, depth] = stack.pop()!;
    if (typeof v === 'string') {
      if (v.length > RAW_LIMITS.string)
        return `${path || 'data'}: ${v.length} characters, at most ${RAW_LIMITS.string}`;
      continue;
    }
    if (typeof v !== 'object' || v === null) continue;
    if (depth >= RAW_LIMITS.depth) return `${path || 'data'}: nested past ${RAW_LIMITS.depth}`;
    if (Array.isArray(v)) {
      if (v.length > RAW_LIMITS.list)
        return `${path || 'data'}: ${v.length} items, at most ${RAW_LIMITS.list}`;
      for (let i = 0; i < v.length; i += 1) stack.push([v[i], `${path}[${i}]`, depth + 1]);
      continue;
    }
    const keys = Object.keys(v);
    if (keys.length > RAW_LIMITS.list)
      return `${path || 'data'}: ${keys.length} members, at most ${RAW_LIMITS.list}`;
    for (const k of keys)
      stack.push([(v as Obj)[k], path ? `${path}.${pathKey(k)}` : pathKey(k), depth + 1]);
  }
  return null;
}

const tooLong = (o: Obj, k: string, max: number, path: string): string | null => {
  const v = o[k];
  return typeof v === 'string' && v.length > max
    ? `${path}${path ? '.' : ''}${k}: ${v.length} characters, at most ${max}`
    : null;
};
const tooMany = (o: Obj, k: string, max: number, path: string): string | null => {
  const v = o[k];
  return Array.isArray(v) && v.length > max
    ? `${path}${path ? '.' : ''}${k}: ${v.length} items, at most ${max}`
    : null;
};

/** One image check mark's fields past CHECK_LIMITS. */
function checkProblem(c: unknown, path: string): string | null {
  if (!isObj(c)) return null;
  for (const [k, max] of Object.entries(CHECK_TEXT)) {
    const p = tooLong(c, k, max, path);
    if (p) return p;
  }
  return (
    tooMany(c, 'crops', CHECK_LIMITS.crops, path) ?? tooMany(c, 'cropSha', CHECK_LIMITS.crops, path)
  );
}

/** One drawing's lists, labels and marks past the template's limits. */
function drawingProblem(d: Obj, path: string): string | null {
  const at = (k: string) => (path ? `${path}.${k}` : k);
  const first = (...found: (string | null)[]) => found.find((x) => x !== null) ?? null;
  let p = first(
    tooLong(d, 'title', PID_LIMITS.text.title, path),
    tooLong(d, 'description', PID_LIMITS.text.description, path),
    ...Object.entries(DRAWING_LISTS).map(([k, max]) => tooMany(d, k, max, path)),
  );
  if (p) return p;
  const offpage = Array.isArray(d.offpage) ? d.offpage : [];
  for (let i = 0; i < offpage.length; i += 1) {
    const o = offpage[i];
    if (!isObj(o)) continue;
    const op = `${at('offpage')}[${i}]`;
    p = first(
      tooLong(o, 'text', PID_LIMITS.text.connector, op),
      checkProblem(o.check, `${op}.check`),
    );
    if (p) return p;
  }
  const lines = Array.isArray(d.lines) ? d.lines : [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (!isObj(l)) continue;
    const lp = `${at('lines')}[${i}]`;
    p = first(
      tooLong(l, 'note', PID_LIMITS.text.note, lp),
      tooLong(l, 'number', PID_LIMITS.text.lineNumber, lp),
      tooMany(l, 'inline', PID_LIMITS.inline, lp),
      tooMany(l, 'checks', LINE_CHECKS_MAX, lp),
      isObj(l.more) ? tooLong(l.more, 'text', PID_LIMITS.text.marker, `${lp}.more`) : null,
    );
    if (p) return p;
    const checks = Array.isArray(l.checks) ? l.checks : [];
    for (let j = 0; j < checks.length; j += 1) {
      p = checkProblem(checks[j], `${lp}.checks[${j}]`);
      if (p) return p;
    }
    const inline = Array.isArray(l.inline) ? l.inline : [];
    for (let j = 0; j < inline.length; j += 1) {
      const it = inline[j];
      if (!isObj(it)) continue;
      const ip = `${lp}.inline[${j}]`;
      p = first(tooLong(it, 'tag', TAG_MAX, ip), checkProblem(it.check, `${ip}.check`));
      if (p) return p;
    }
  }
  return null;
}

/** The named limits: a set's pages, then each drawing's. */
function namedProblem(data: unknown): string | null {
  if (!isObj(data)) return null;
  if (!Array.isArray(data.pages)) return drawingProblem(data, '');
  const set = data;
  const p =
    tooMany(set, 'pages', SET_LIMITS.pages, '') ??
    tooLong(set, 'title', PID_LIMITS.text.title, '') ??
    tooLong(set, 'description', PID_LIMITS.text.description, '');
  if (p) return p;
  const pages = set.pages as unknown[];
  for (let i = 0; i < pages.length; i += 1) {
    const pg = pages[i];
    if (!isObj(pg)) continue;
    const pp = `pages[${i}]`;
    const q =
      tooLong(pg, 'title', SET_LIMITS.pageTitle, pp) ??
      (isObj(pg.data) ? drawingProblem(pg.data, `${pp}.data`) : null);
    if (q) return q;
  }
  return null;
}
