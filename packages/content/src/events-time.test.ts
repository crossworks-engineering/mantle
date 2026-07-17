/**
 * Tests for the pure events-time helpers.
 *
 * `computeRemindAt` is instant arithmetic in UTC milliseconds, so DST
 * transitions don't shift the result — that's the property we're
 * locking down here. `sanitiseTimezone` falls back to UTC for any
 * input the runtime doesn't recognise, so a malicious / mangled tz
 * string from a client can't crash the reminder formatter.
 */

import { describe, expect, it } from 'vitest';
import {
  advanceToNextFuture,
  computeRemindAt,
  nextOccurrence,
  sanitiseRecur,
  sanitiseTimezone,
} from './events-time';

describe('sanitiseTimezone', () => {
  it('passes through a known IANA zone', () => {
    expect(sanitiseTimezone('Africa/Johannesburg')).toBe('Africa/Johannesburg');
    expect(sanitiseTimezone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(sanitiseTimezone('UTC')).toBe('UTC');
  });

  it('falls back to UTC for an unrecognised zone', () => {
    expect(sanitiseTimezone('Atlantis/Lost')).toBe('UTC');
    expect(sanitiseTimezone('not a timezone')).toBe('UTC');
  });

  it('falls back to UTC for empty / undefined / very long strings', () => {
    expect(sanitiseTimezone(undefined)).toBe('UTC');
    expect(sanitiseTimezone('')).toBe('UTC');
    expect(sanitiseTimezone('a'.repeat(100))).toBe('UTC');
  });
});

describe('computeRemindAt', () => {
  it('subtracts whole minutes', () => {
    expect(computeRemindAt('2026-05-20T10:00:00Z', 15)).toBe('2026-05-20T09:45:00.000Z');
  });

  it('handles 0 (remind at start)', () => {
    expect(computeRemindAt('2026-05-20T10:00:00Z', 0)).toBe('2026-05-20T10:00:00.000Z');
  });

  it('handles a 1-day lead time', () => {
    expect(computeRemindAt('2026-05-20T10:00:00Z', 60 * 24)).toBe('2026-05-19T10:00:00.000Z');
  });

  it('is DST-safe: same offset before and after a CET spring-forward', () => {
    // 2026-03-29 02:00 CET → 03:00 CEST (Europe/Berlin spring-forward).
    // A reminder 60 min before an event at 04:00 CEST = 03:00 CEST =
    // 01:00 UTC. A reminder 60 min before an event at 23:00 CET on the
    // 28th = 22:00 CET = 21:00 UTC. Both computed in UTC instants —
    // DST doesn't enter the calculation because we're not doing local-
    // calendar math.
    expect(computeRemindAt('2026-03-29T02:00:00Z', 60)).toBe('2026-03-29T01:00:00.000Z');
    expect(computeRemindAt('2026-03-29T03:00:00Z', 60)).toBe('2026-03-29T02:00:00.000Z');
  });

  it('crosses a day boundary', () => {
    expect(computeRemindAt('2026-05-20T00:30:00Z', 60)).toBe('2026-05-19T23:30:00.000Z');
  });

  it('throws on invalid starts_at', () => {
    expect(() => computeRemindAt('not a date', 5)).toThrow(/invalid/);
  });

  it('rejects NaN-induced output', () => {
    // Guards against future regressions where minutesBefore is NaN.
    // `0 - NaN * 60_000` is NaN; new Date(NaN).toISOString() throws.
    expect(() => computeRemindAt('2026-05-20T10:00:00Z', Number.NaN)).toThrow();
  });
});

describe('sanitiseRecur', () => {
  it('passes through valid frequencies', () => {
    for (const f of ['none', 'daily', 'weekly', 'monthly', 'yearly'] as const) {
      expect(sanitiseRecur(f)).toBe(f);
    }
  });
  it('falls back to none for junk / wrong type', () => {
    expect(sanitiseRecur('fortnightly')).toBe('none');
    expect(sanitiseRecur(undefined)).toBe('none');
    expect(sanitiseRecur(7)).toBe('none');
    expect(sanitiseRecur(null)).toBe('none');
  });
});

describe('nextOccurrence', () => {
  it('daily adds 24h (DST-agnostic UTC instant)', () => {
    expect(nextOccurrence('2026-05-20T09:00:00.000Z', 'daily')).toBe('2026-05-21T09:00:00.000Z');
  });
  it('weekly adds 7 days', () => {
    expect(nextOccurrence('2026-05-20T09:00:00.000Z', 'weekly')).toBe('2026-05-27T09:00:00.000Z');
  });
  it('monthly preserves day-of-month and time', () => {
    expect(nextOccurrence('2026-05-15T08:30:00.000Z', 'monthly')).toBe('2026-06-15T08:30:00.000Z');
  });
  it('monthly clamps to end-of-month instead of overflowing', () => {
    // Jan 31 + 1 month → Feb 28 (2026 is not a leap year), NOT Mar 3.
    expect(nextOccurrence('2026-01-31T10:00:00.000Z', 'monthly')).toBe('2026-02-28T10:00:00.000Z');
  });
  it('yearly clamps Feb 29 → Feb 28 on a non-leap target', () => {
    // 2028 is a leap year; +1 year lands on 2029 which is not.
    expect(nextOccurrence('2028-02-29T12:00:00.000Z', 'yearly')).toBe('2029-02-28T12:00:00.000Z');
  });
  it('none returns the same instant', () => {
    expect(nextOccurrence('2026-05-20T09:00:00.000Z', 'none')).toBe('2026-05-20T09:00:00.000Z');
  });
});

describe('advanceToNextFuture', () => {
  const now = Date.parse('2026-05-20T12:00:00Z');

  it('steps a single past daily occurrence to the next future one', () => {
    // Yesterday 09:00 → next future hit is tomorrow 09:00 (today 09:00 is
    // already past `now`, so it skips it).
    expect(advanceToNextFuture('2026-05-19T09:00:00.000Z', 'daily', 0, now)).toBe(
      '2026-05-21T09:00:00.000Z',
    );
  });

  it('collapses a long backlog into one hop (no burst)', () => {
    // A daily event 10 days stale rolls forward to the first future hit,
    // not ten times.
    const result = advanceToNextFuture('2026-05-10T09:00:00.000Z', 'daily', 0, now);
    expect(result).toBe('2026-05-21T09:00:00.000Z');
  });

  it('honours the reminder lead time when deciding "future"', () => {
    // remind 60m before. An occurrence at 12:30 has remind_at 11:30 (past
    // 12:00 now) so it's skipped; next day 12:30 (remind 11:30) is future.
    expect(advanceToNextFuture('2026-05-20T12:30:00.000Z', 'daily', 60, now)).toBe(
      '2026-05-21T12:30:00.000Z',
    );
  });

  it('advances at least once even when already future', () => {
    // The current occurrence's reminder just fired, so we always move on.
    expect(advanceToNextFuture('2026-05-25T09:00:00.000Z', 'weekly', 0, now)).toBe(
      '2026-06-01T09:00:00.000Z',
    );
  });

  it('none is a no-op', () => {
    expect(advanceToNextFuture('2026-05-19T09:00:00.000Z', 'none', 0, now)).toBe(
      '2026-05-19T09:00:00.000Z',
    );
  });
});
