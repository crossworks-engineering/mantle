/**
 * Pure time/timezone helpers used by the events surface. Lives in its
 * own module so vitest can import these without dragging in the
 * `@mantle/db` runtime (postgres-js + drizzle) that the rest of
 * events.ts pulls in.
 */

/**
 * Defence-in-depth: ensure the string is a real IANA zone before we
 * store it. Anything we don't recognise falls back to 'UTC' so we
 * never end up writing junk that crashes the reminder formatter.
 */
export function sanitiseTimezone(tz: string | undefined): string {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return 'UTC';
  try {
    // The constructor throws RangeError on an invalid IANA name.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/**
 * Pure instant arithmetic: starts_at - n minutes, as a UTC ISO string.
 *
 * This is correct across DST transitions BECAUSE we work with UTC
 * milliseconds, not local wall-clock. "Remind me 60 min before
 * 2026-03-29 03:00 CET" produces a reminder at 2026-03-29 01:00 UTC
 * regardless of whether DST has shifted yet — same actual instant.
 *
 * Throws if startsAt isn't a valid date; callers validate up the stack.
 */
export function computeRemindAt(startsAt: string, minutesBefore: number): string {
  const t = new Date(startsAt).getTime();
  if (Number.isNaN(t)) throw new Error(`computeRemindAt: invalid starts_at "${startsAt}"`);
  return new Date(t - minutesBefore * 60_000).toISOString();
}

/**
 * Recurrence frequencies an event can repeat on. `none` is the default —
 * a one-shot event. The reminder worker rolls a recurring event's single
 * row forward to its next occurrence after each ping (no instance
 * materialisation), so one node always represents the next upcoming hit.
 */
export type RecurFreq = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

const RECUR_FREQS: readonly RecurFreq[] = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

/** Coerce arbitrary input to a valid RecurFreq, defaulting to 'none'. */
export function sanitiseRecur(v: unknown): RecurFreq {
  return typeof v === 'string' && (RECUR_FREQS as readonly string[]).includes(v)
    ? (v as RecurFreq)
    : 'none';
}

/**
 * Add `n` calendar months to a UTC instant, clamping the day-of-month so
 * we never overflow into the following month. e.g. Jan 31 + 1 month →
 * Feb 28 (not Mar 3, which JS's naive `setUTCMonth` produces). Yearly
 * recurrence is months × 12, so Feb 29 → Feb 28 on a non-leap year too.
 */
function addUtcMonths(iso: string, n: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  // First land on day 1 of the target month so the clamp math is clean.
  const target = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + n,
      1,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
  // Last day of the target month: day 0 of the *next* month.
  const daysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target.toISOString();
}

/**
 * The next occurrence of a UTC instant under a recurrence frequency —
 * exactly one step forward. `none` returns the input unchanged (callers
 * guard against this). Daily/weekly are pure instant arithmetic (DST-safe
 * the same way `computeRemindAt` is); monthly/yearly use the clamped
 * calendar walk so wall-clock day-of-month stays stable.
 */
export function nextOccurrence(startsAt: string, freq: RecurFreq): string {
  const t = new Date(startsAt).getTime();
  if (Number.isNaN(t)) throw new Error(`nextOccurrence: invalid starts_at "${startsAt}"`);
  switch (freq) {
    case 'daily':
      return new Date(t + 86_400_000).toISOString();
    case 'weekly':
      return new Date(t + 7 * 86_400_000).toISOString();
    case 'monthly':
      return addUtcMonths(startsAt, 1);
    case 'yearly':
      return addUtcMonths(startsAt, 12);
    case 'none':
    default:
      return new Date(t).toISOString();
  }
}

/**
 * Roll a recurring event forward to the first occurrence whose reminder
 * time is still in the future relative to `nowMs`. Always advances at
 * least once (we've just fired the current occurrence's reminder), then
 * keeps stepping to collapse a backlog of missed occurrences into a
 * single catch-up — so a daily event the worker was down for a week
 * fires once and re-arms for tomorrow, not seven times in seven ticks.
 *
 * Returns the next `starts_at` ISO instant. Bounded to 10k iterations as
 * a defensive guard against a pathological freq/clock combination.
 */
export function advanceToNextFuture(
  startsAt: string,
  freq: RecurFreq,
  remindMinutesBefore: number,
  nowMs: number,
): string {
  if (freq === 'none') return startsAt;
  let next = startsAt;
  for (let i = 0; i < 10_000; i++) {
    next = nextOccurrence(next, freq);
    if (new Date(computeRemindAt(next, remindMinutesBefore)).getTime() > nowMs) {
      break;
    }
  }
  return next;
}
