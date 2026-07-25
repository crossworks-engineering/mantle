/**
 * Draft manipulation for the formula editor — the pure half, kept out of the
 * component so it can be tested.
 *
 * A draft is a spec MID-EDIT and therefore usually invalid: half a symbol
 * typed, a lookup with keys but no rows yet. Nothing here validates; only
 * `parseFormulaSpec` decides what a FormulaSpec is. What these functions must
 * guarantee is that editing never silently CHANGES the author's meaning — the
 * form and the YAML view are two windows onto one object, and a round trip
 * through either has to be lossless.
 */

export type Row = Record<string, unknown>;
export type Draft = Record<string, unknown>;

export const SPEC_ARRAYS = [
  'variables',
  'expressions',
  'piecewise',
  'lookups',
  'classifications',
] as const;

export function arr(draft: Draft, key: string): Row[] {
  const v = draft[key];
  return Array.isArray(v) ? (v as Row[]) : [];
}

export function obj(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

export function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** Split a comma list into a string array, dropping blanks. */
export function listOf(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A number where the text reads as one, else the text.
 *
 * Both directions matter. Storing `0.61` as the string `'0.61'` would leave
 * `toNum` to re-parse it at evaluation time, and a lookup keyed on a number
 * would stop matching its own rows (`row[k] === key[k]` is strict). But
 * coercing everything would be worse: a hole size of `'1/4 in'` and a rating of
 * `'A'` are values, not arithmetic, and `'1.2.3'` is a version string rather
 * than NaN.
 */
export function scalar(raw: string): unknown {
  const t = raw.trim();
  if (t === '') return undefined;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (!/^[-+]?[0-9.]+(e[-+]?[0-9]+)?$/i.test(t)) return t;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

/**
 * Drop empty strings, arrays and objects, so the YAML view and the saved spec
 * stay free of noise the author never typed — an untouched `latex` field
 * should not appear in the source view, let alone in the stored spec.
 *
 * `false` and `0` are VALUES and survive; only genuinely absent things go.
 */
export function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    const out = value.map(prune).filter((v) => v !== undefined);
    return out.length > 0 ? out : undefined;
  }
  if (value && typeof value === 'object') {
    const out: Row = {};
    for (const [k, v] of Object.entries(value as Row)) {
      const pruned = prune(v);
      if (pruned !== undefined) out[k] = pruned;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (value === '' || value === null) return undefined;
  return value;
}

/** The spec always carries its five arrays, even when empty — the validator
 *  reports a missing one as an error and an author should not have to guess
 *  which section they were supposed to open. */
export function normalised(draft: Draft): Draft {
  const out: Draft = { ...draft };
  for (const key of SPEC_ARRAYS) {
    if (!Array.isArray(out[key])) out[key] = [];
  }
  return out;
}

/** What actually gets sent to the API, and what the source view serialises. */
export function toSpec(draft: Draft): Record<string, unknown> {
  return (prune(normalised(draft)) ?? {}) as Record<string, unknown>;
}
