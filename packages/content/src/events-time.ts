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
