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

import { parseInputText } from '@mantle/content-core/formula-eval';

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
 *
 * Delegates to the ONE coercer beside the evaluator — three UIs each grew a
 * near-copy with different numeric regexes, and the divergence is exactly the
 * kind of wrong that only shows on a numeric lookup key.
 */
export function scalar(raw: string): unknown {
  return parseInputText(raw);
}

/**
 * Drop empty strings, arrays and objects, so the YAML view and the saved spec
 * stay free of noise the author never typed — an untouched `latex` field
 * should not appear in the source view, let alone in the stored spec.
 *
 * `false` and `0` are VALUES and survive; only genuinely absent things go.
 *
 * `keepEmpty` protects LOOKUP ROWS. A `null` cell is a legal value there
 * (`isScalar` allows it, and an `onMiss: 'null'` table legitimately carries
 * them) — the first cut pruned it like any other absence, so a VALID stored
 * spec came back from the editor with the cell gone, failed validation on a
 * "missing result" it never had, and could not be saved at all.
 */
export function prune(value: unknown, keepEmpty = false): unknown {
  if (Array.isArray(value)) {
    const out = value.map((v) => prune(v, keepEmpty)).filter((v) => v !== undefined);
    return out.length > 0 ? out : undefined;
  }
  if (value && typeof value === 'object') {
    const out: Row = {};
    for (const [k, v] of Object.entries(value as Row)) {
      // Everything under a `rows` key is table DATA, where null and '' are
      // cell values rather than editor noise.
      const pruned = prune(v, keepEmpty || k === 'rows');
      if (pruned !== undefined) out[k] = pruned;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (!keepEmpty && (value === '' || value === null)) return undefined;
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
