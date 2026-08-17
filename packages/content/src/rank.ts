/**
 * Fractional ordering keys for board/drag ordering (tasks first).
 *
 * A rank is a base-36 string (`[0-9a-z]`); rows sort by plain lexicographic
 * comparison. `rankBetween(a, b)` returns a key strictly between its bounds
 * without touching any other row — a drag writes ONE row, never a renumber.
 *
 * Invariant: generated keys never end in '0' (the smallest digit), so a
 * strictly-between key always exists. Keys grow one char only when a gap
 * has been halved ~36 times, which drag patterns never approach.
 */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

export const RANK_RE = /^[0-9a-z]{1,64}$/;

/** True when `value` is usable as a stored rank key. */
export function isValidRank(value: unknown): value is string {
  return typeof value === 'string' && RANK_RE.test(value);
}

/**
 * A key strictly between `after` and `before` (each may be null/undefined for
 * an open end). With both ends open returns the midpoint key `'i'`. Throws if
 * the bounds are malformed or not in order — callers pass neighbours they just
 * read, so a violation is a programming error, not user input.
 */
export function rankBetween(after?: string | null, before?: string | null): string {
  const lo = after ?? '';
  let hi = before ?? '';
  if (lo && !RANK_RE.test(lo)) throw new Error(`rankBetween: bad lower bound '${lo}'`);
  if (hi && !RANK_RE.test(hi)) throw new Error(`rankBetween: bad upper bound '${hi}'`);
  if (hi && lo >= hi) {
    throw new Error(`rankBetween: lower bound '${lo}' must sort before upper bound '${hi}'`);
  }
  let out = '';
  for (let i = 0; ; i++) {
    const da = i < lo.length ? DIGITS.indexOf(lo.charAt(i)) : 0;
    // An exhausted/open upper bound admits every digit — treat it as BASE.
    const db = hi && i < hi.length ? DIGITS.indexOf(hi.charAt(i)) : BASE;
    if (da === db) {
      out += DIGITS.charAt(da);
      continue;
    }
    if (db - da === 1) {
      // Adjacent digits: keep the lower one; everything after it only has to
      // beat the REST of `lo`, so the upper bound falls away.
      out += DIGITS.charAt(da);
      hi = '';
      continue;
    }
    out += DIGITS.charAt(Math.floor((da + db) / 2));
    return out;
  }
}

/** N keys in order after `after` (e.g. appending several rows at the end). */
export function ranksAfter(after: string | null | undefined, count: number): string[] {
  const out: string[] = [];
  let prev = after ?? null;
  for (let i = 0; i < count; i++) {
    prev = rankBetween(prev, null);
    out.push(prev);
  }
  return out;
}
