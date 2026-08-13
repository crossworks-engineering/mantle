/**
 * Deterministic date/time formatting for React components that render
 * on BOTH the server (Node) and the client (browser).
 *
 * `Date.prototype.toLocaleString()` without arguments returns different
 * strings on the two sides — Node uses the OS locale, the browser uses
 * the user's preference. That diverges the SSR HTML from the hydrated
 * tree and triggers a React hydration mismatch warning. Symptom: a
 * red error in dev about "server rendered text didn't match the
 * client", and the affected subtree gets regenerated on the client.
 *
 * Fix: pin the locale on every call. We use 'en-GB' across the app —
 * the user is in South Africa, en-GB matches local conventions
 * (DD/MM/YYYY, 24-hour time) and renders identically wherever Node
 * runs. If we ever localise the UI properly, swap this for an i18n
 * provider read from a cookie that's shared between SSR + client.
 *
 * Three formats covered:
 *   - formatDateTime: '19/05/2026, 10:38:41'  — full timestamp
 *   - formatDate:     '19/05/2026'             — date only
 *   - formatTime:     '10:38:41'               — time only
 *
 * All three accept Date | string | number | null | undefined and return
 * 'never' for missing values so callers don't have to do the null check.
 */

const LOCALE = 'en-GB';

const DATETIME_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
};

const TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

type Input = Date | string | number | null | undefined;

function toDate(input: Input): Date | null {
  if (input == null) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(input: Input, missing = 'never'): string {
  const d = toDate(input);
  if (!d) return missing;
  return new Intl.DateTimeFormat(LOCALE, DATETIME_OPTS).format(d);
}

export function formatDate(input: Input, missing = 'never'): string {
  const d = toDate(input);
  if (!d) return missing;
  return new Intl.DateTimeFormat(LOCALE, DATE_OPTS).format(d);
}

export function formatTime(input: Input, missing = 'never'): string {
  const d = toDate(input);
  if (!d) return missing;
  return new Intl.DateTimeFormat(LOCALE, TIME_OPTS).format(d);
}

/**
 * `YYYY-MM-DD` in the viewer's LOCAL timezone (defaults to now). Use this to
 * compare against day-bucketed date strings — `new Date().toISOString().slice(0,10)`
 * is UTC, so it highlights the wrong day for a viewer whose local date differs
 * from UTC (e.g. evening in the Americas, or already-tomorrow in APAC).
 */
export function localDay(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
