/**
 * Argument coercion helpers for builtin tool handlers.
 *
 * Tool handlers receive `input` as loosely-typed JSON (the model can send us
 * anything the schema doesn't hard-reject — a number where we wanted a string,
 * `null`, a missing key). Rather than sprinkle `typeof x === 'string'` guards
 * through every handler, each `builtins-*.ts` file used to define its own tiny
 * `str` / `strArr` pair. Audit item #5a found ~20 copies of `str` and a handful
 * of `strArr` variants that had quietly *drifted* apart — same name, subtly
 * different behaviour depending on which file you landed in. This module is the
 * single source of truth so the coercion contract is uniform and reviewable.
 *
 * Deliberately NOT centralised here (they are genuinely different behaviours,
 * kept local to their one call site so nobody mistakes them for the canonical
 * form): `builtins-profile.ts`'s trimming `str`, `builtins.ts`'s empty-dropping
 * `strArr`, and `builtins-contacts.ts`'s trim-and-drop `strArr`.
 */

/** Coerce an unknown to a string, defaulting to `''` for anything non-string
 *  (number, null, undefined, object). Does NOT trim — callers that need a
 *  trimmed value chain `.trim()` at the call site, keeping the empty-string
 *  fallback contract obvious. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Coerce an unknown to a `string[]`, keeping only the string members and
 *  returning `[]` for a non-array. Empty-string members are preserved — filter
 *  those at the call site if they matter. Use this when the handler always
 *  wants an array to iterate (never `undefined`). */
export function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
}

/** Like {@link strArr}, but collapses "no usable values" to `undefined` rather
 *  than `[]`. This is the shape update-style handlers want: `undefined` means
 *  "leave the field unchanged", whereas `[]` would mean "clear it". Empty-string
 *  members are preserved (they still count toward "usable"), matching the
 *  legacy tasks/events/peers behaviour this replaces. */
export function strArrOpt(v: unknown): string[] | undefined {
  const out = strArr(v);
  return out.length > 0 ? out : undefined;
}
