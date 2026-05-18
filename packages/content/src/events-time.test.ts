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
import { computeRemindAt, sanitiseTimezone } from './events-time';

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
    expect(computeRemindAt('2026-05-20T10:00:00Z', 60 * 24)).toBe(
      '2026-05-19T10:00:00.000Z',
    );
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
    expect(computeRemindAt('2026-05-20T00:30:00Z', 60)).toBe(
      '2026-05-19T23:30:00.000Z',
    );
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
