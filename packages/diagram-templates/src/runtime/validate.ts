/**
 * Data checks with errors an agent can act on: each names the exact path
 * (`edges[3].to`), what is wrong and, where it can, the fix ("did you mean
 * 'label'?"). Errors stop the render; warnings render and are reported
 * beside the picture.
 */

export type Issues = { errors: string[]; warnings: string[] };

/** The text of a thrown value. Local, not @mantle/std's errorMessage: this
 *  package runs in the browser and takes no server dependency. */
export function messageOf(err: unknown): string {
  return String((err as { message?: unknown } | null)?.message ?? err);
}

export function newIssues(): Issues {
  return { errors: [], warnings: [] };
}

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function at(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[a.length]![b.length]!;
}

/** The closest of `options` to `value`, when it is close enough to be a typo. */
export function suggest(value: string, options: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const o of options) {
    const dd = editDistance(value.toLowerCase(), o.toLowerCase());
    if (dd < bestD) {
      bestD = dd;
      best = o;
    }
  }
  return best !== null && bestD <= Math.max(2, Math.floor(value.length / 3)) ? best : null;
}

function hint(value: string, options: readonly string[]): string {
  const s = suggest(value, options);
  return s ? ` (did you mean '${s}'?)` : '';
}

/** Unknown fields are errors: a typo must never be silently ignored. */
export function checkKeys(o: Obj, allowed: readonly string[], path: string, issues: Issues): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      issues.errors.push(
        `${path || 'data'}: unknown field '${k}'${hint(k, allowed)}. Allowed: ${allowed.join(', ')}.`,
      );
    }
  }
}

type StrOpts = { required?: boolean; max?: number; pattern?: RegExp; patternText?: string };

/** C0 and C1 control characters and DEL, but tab, newline and carriage
 *  return: never drawn (a NUL makes the SVG invalid XML even escaped). A
 *  carriage return is kept so stored text with CRLF line ends draws byte for
 *  byte as it did. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** A text field with its control characters taken out (tab, newline and
 *  carriage return kept); text without any is returned as it is. */
export function cleanText(v: string): string {
  return v.replace(CONTROL, '');
}

/**
 * A string field: every free text a template takes (titles, labels, notes,
 * legend names) comes through here, so control characters are taken out
 * once, before the length and pattern checks; text without them is the
 * same string (stored drawings draw byte for byte as they did).
 */
export function str(
  o: Obj,
  key: string,
  path: string,
  issues: Issues,
  opts: StrOpts = {},
): string | undefined {
  const raw = o[key];
  const p = at(path, key);
  const v = typeof raw === 'string' ? cleanText(raw) : raw;
  if (v === undefined || v === null || v === '') {
    if (opts.required) issues.errors.push(`${p}: required, a non-empty string.`);
    return undefined;
  }
  if (typeof v !== 'string') {
    issues.errors.push(`${p}: must be a string, got ${typeof v}.`);
    return undefined;
  }
  if (opts.max && v.length > opts.max) {
    issues.errors.push(`${p}: at most ${opts.max} characters, got ${v.length}. Shorten it.`);
  }
  if (opts.pattern && !opts.pattern.test(v)) {
    issues.errors.push(`${p}: '${v}' is not ${opts.patternText ?? `in the form ${opts.pattern}`}.`);
  }
  return v;
}

export function oneOf<T extends string>(
  o: Obj,
  key: string,
  values: readonly T[],
  path: string,
  issues: Issues,
): T | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !values.includes(v as T)) {
    const shown = typeof v === 'string' ? `'${v}'` : typeof v;
    issues.errors.push(
      `${at(path, key)}: ${shown} is not one of ${values.join(', ')}${typeof v === 'string' ? hint(v, values) : ''}.`,
    );
    return undefined;
  }
  return v as T;
}

export function bool(o: Obj, key: string, path: string, issues: Issues): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') {
    issues.errors.push(`${at(path, key)}: must be true or false.`);
    return undefined;
  }
  return v;
}

export function number(
  o: Obj,
  key: string,
  path: string,
  issues: Issues,
  range: { min?: number; max?: number } = {},
): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    issues.errors.push(`${at(path, key)}: must be a number.`);
    return undefined;
  }
  if ((range.min !== undefined && v < range.min) || (range.max !== undefined && v > range.max)) {
    issues.errors.push(
      `${at(path, key)}: ${v} is outside ${range.min ?? '-inf'}..${range.max ?? 'inf'}.`,
    );
  }
  return v;
}

export function list(
  o: Obj,
  key: string,
  path: string,
  issues: Issues,
  opts: { required?: boolean; max?: number } = {},
): unknown[] {
  const v = o[key];
  const p = at(path, key);
  if (v === undefined || v === null) {
    if (opts.required) issues.errors.push(`${p}: required, a list.`);
    return [];
  }
  if (!Array.isArray(v)) {
    issues.errors.push(`${p}: must be a list.`);
    return [];
  }
  if (opts.max !== undefined && v.length > opts.max) {
    issues.errors.push(`${p}: at most ${opts.max} items, got ${v.length}. Split the drawing.`);
  }
  return v;
}

/** Each item an object; returns [path, obj] pairs for the valid ones. */
export function objects(items: unknown[], path: string, issues: Issues): [string, Obj][] {
  const out: [string, Obj][] = [];
  items.forEach((it, i) => {
    if (isObj(it)) out.push([at(path, i), it]);
    else issues.errors.push(`${at(path, i)}: must be an object.`);
  });
  return out;
}

/** Ids must be short, readable and unique. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:"/-]{0,63}$/;

export function idOf(
  o: Obj,
  path: string,
  issues: Issues,
  seen: Map<string, string>,
  key = 'id',
): string | undefined {
  const id = str(o, key, path, issues, {
    required: true,
    pattern: ID_PATTERN,
    patternText: 'a valid id (letters, digits and _ . : / - " only, up to 64 characters)',
  });
  if (id === undefined) return undefined;
  const prev = seen.get(id);
  if (prev) issues.errors.push(`${at(path, key)}: id '${id}' is already used by ${prev}.`);
  else seen.set(id, path);
  return id;
}

/** A reference to an id that must exist. */
export function ref(
  o: Obj,
  key: string,
  path: string,
  issues: Issues,
  known: Map<string, string>,
  what = 'node',
): string | undefined {
  const v = str(o, key, path, issues, { required: true });
  if (v === undefined) return undefined;
  if (!known.has(v)) {
    issues.errors.push(`${at(path, key)}: no ${what} with id '${v}'${hint(v, [...known.keys()])}.`);
    return undefined;
  }
  return v;
}

/** The result of a validation: the typed data, or the errors. */
export type Checked<T> =
  { ok: true; data: T; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };

export function done<T>(issues: Issues, data: T): Checked<T> {
  return issues.errors.length
    ? { ok: false, errors: issues.errors, warnings: issues.warnings }
    : { ok: true, data, warnings: issues.warnings };
}
