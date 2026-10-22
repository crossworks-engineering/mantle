/**
 * The two env dialects, as pure functions of the raw string (A10 #11;
 * docs/configuration.md, "Flags and env"). Every flag and every number the
 * tree reads from the environment goes through one of these, through
 * `envFlag` / `envInt` / `envNumber` (index.ts) or the registries
 * (features.ts, numbers.ts). A hand parse elsewhere is a lint error
 * (eslint-rules/env-flags.mjs).
 *
 * Before: 57 number readers and 19 flag readers parsed by hand, the flags
 * in seven dialects. `'0'` turned one flag off and not its neighbour; `''` (what compose passes for
 * an unset `${VAR:-}`) read as 0 in some number parses and as the default in
 * others; garbage read as NaN, as the default, or as "on".
 *
 * One rule now, for both: blank (unset, empty, spaces) and unrecognised
 * input mean the default. A value that is clearly given is honoured.
 */

/** Words a flag reads as on, and as off (any case, trimmed). */
export const FLAG_ON_WORDS = ['1', 'true', 'yes', 'on'] as const;
export const FLAG_OFF_WORDS = ['0', 'false', 'no', 'off'] as const;

/**
 * A flag from its raw string: an on word is true, an off word is false,
 * anything else (unset, blank, garbage) is `fallback`. So a default-on flag
 * is an off switch (only an off word turns it off) and a default-off flag an
 * on switch (only an on word turns it on), from the one rule.
 */
export function parseFlag(
  raw: string | null | undefined,
  fallback: boolean,
  name?: string,
): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v) return fallback;
  if ((FLAG_ON_WORDS as readonly string[]).includes(v)) return true;
  if ((FLAG_OFF_WORDS as readonly string[]).includes(v)) return false;
  // A word that is neither (a typo of a kill switch: `of`, `disable`): the
  // default still holds, and the process says so once per name and word,
  // with what it took, so a switch that did not take is seen in the log.
  if (name) {
    const key = `${name}=${v}`;
    if (!warnedFlags.has(key)) {
      warnedFlags.add(key);
      console.warn(
        `[config] ${name}: "${v}" is not an on word (${FLAG_ON_WORDS.join(', ')}) or an off word (${FLAG_OFF_WORDS.join(', ')}); taken as ${fallback ? 'on' : 'off'}, its default`,
      );
    }
  }
  return fallback;
}

const warnedFlags = new Set<string>();

/** How a number is held to its range. Applied in this order: */
export type NumberOptions = {
  /** Whole numbers: `floor` (a count) or `round` (a resolution). */
  int?: 'floor' | 'round';
  /** Then a value at or below 0 means the default (a size, a count, a
   *  period: `0.5` of a count is 0, and 0 of it is the default too). */
  positive?: boolean;
  /** Then a value below this means the default. */
  atLeast?: number;
  /** Then clamped into [min, max]. */
  min?: number;
  max?: number;
};

/**
 * A number from its raw string: blank (unset, empty, spaces) or not a finite
 * number (`Number()` of the trimmed text, so `16abc` and `garbage` are not
 * numbers) means `fallback`; otherwise the options apply in their order:
 * int, then positive and atLeast (each falls back), then the min / max
 * clamp.
 */
export function parseNumber(
  raw: string | null | undefined,
  fallback: number,
  opts: NumberOptions = {},
): number {
  const s = raw?.trim();
  if (!s) return fallback;
  let n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  if (opts.int === 'floor') n = Math.floor(n);
  else if (opts.int === 'round') n = Math.round(n);
  if (opts.positive && n <= 0) return fallback;
  if (opts.atLeast !== undefined && n < opts.atLeast) return fallback;
  if (opts.min !== undefined) n = Math.max(opts.min, n);
  if (opts.max !== undefined) n = Math.min(opts.max, n);
  return n;
}
