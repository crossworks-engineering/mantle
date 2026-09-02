/**
 * Tests for the time-of-day window check that powers quiet_hours.
 *
 * The DB-touching parts of `checkGates` (cooldown, idle telegram
 * lookup) need a fixture and are exercised via integration. The
 * trickiest piece is `isInsideWindow` — it has to handle both
 * same-day windows and windows that cross midnight, AND it has to
 * honour the heartbeat's chosen timezone (NOT UTC, NOT process
 * locale). All three of those have historically produced subtle
 * bugs in other systems; pin them here.
 */

import { describe, expect, it } from 'vitest';
import { isInsideWindow } from './gates';

// A consistent set of UTC instants we can reason about.
// At 12:00 UTC, the corresponding wall-clock times are:
//   UTC                        12:00
//   Africa/Johannesburg (+2)   14:00
//   America/New_York (-4 DST)  08:00
//   Asia/Tokyo (+9)            21:00
//   Pacific/Auckland (+12 DST) 00:00 (next day)
const NOON_UTC = new Date('2026-05-19T12:00:00Z');

describe('isInsideWindow — same-day window (no midnight cross)', () => {
  it('returns true when now is inside the window', () => {
    // 14:00 in Joburg, window 13:00–17:00 → inside.
    expect(isInsideWindow(NOON_UTC, '13:00', '17:00', 'Africa/Johannesburg')).toBe(true);
  });

  it('returns false when now is before the window opens', () => {
    // 08:00 in NY, window 09:00–17:00 → before.
    expect(isInsideWindow(NOON_UTC, '09:00', '17:00', 'America/New_York')).toBe(false);
  });

  it('returns false when now is after the window closes', () => {
    // 21:00 in Tokyo, window 09:00–17:00 → after.
    expect(isInsideWindow(NOON_UTC, '09:00', '17:00', 'Asia/Tokyo')).toBe(false);
  });

  it('treats `to` as exclusive (window ends just before to)', () => {
    // 14:00 in Joburg, window 13:00–14:00 → not inside (to is exclusive).
    expect(isInsideWindow(NOON_UTC, '13:00', '14:00', 'Africa/Johannesburg')).toBe(false);
  });

  it('treats `from` as inclusive', () => {
    // 14:00 in Joburg, window 14:00–15:00 → inside (from is inclusive).
    expect(isInsideWindow(NOON_UTC, '14:00', '15:00', 'Africa/Johannesburg')).toBe(true);
  });
});

describe('isInsideWindow — cross-midnight window (the quiet-hours classic)', () => {
  it('returns true after `from` (late evening)', () => {
    // 23:00 in Joburg (UTC 21:00), window 22:00–07:00 → inside (it is night).
    const late = new Date('2026-05-19T21:00:00Z');
    expect(isInsideWindow(late, '22:00', '07:00', 'Africa/Johannesburg')).toBe(true);
  });

  it('returns true before `to` (early morning)', () => {
    // 05:00 in Joburg (UTC 03:00), window 22:00–07:00 → inside.
    const earlyMorning = new Date('2026-05-19T03:00:00Z');
    expect(isInsideWindow(earlyMorning, '22:00', '07:00', 'Africa/Johannesburg')).toBe(true);
  });

  it('returns false in the middle of the day', () => {
    // 14:00 in Joburg (NOON_UTC), window 22:00–07:00 → outside.
    expect(isInsideWindow(NOON_UTC, '22:00', '07:00', 'Africa/Johannesburg')).toBe(false);
  });

  it('returns true exactly at `from`', () => {
    // 22:00 in Joburg (UTC 20:00). Inclusive lower bound.
    const sharp = new Date('2026-05-19T20:00:00Z');
    expect(isInsideWindow(sharp, '22:00', '07:00', 'Africa/Johannesburg')).toBe(true);
  });

  it('returns false exactly at `to`', () => {
    // 07:00 in Joburg (UTC 05:00). Exclusive upper bound.
    const sharp = new Date('2026-05-19T05:00:00Z');
    expect(isInsideWindow(sharp, '22:00', '07:00', 'Africa/Johannesburg')).toBe(false);
  });
});

describe('isInsideWindow — timezone independence from process locale', () => {
  it('uses the supplied tz, not UTC', () => {
    // UTC 12:00 is 14:00 in Joburg; quiet-from 13:00–15:00 should hit.
    // Same instant in UTC tz: 12:00 → not in 13:00–15:00.
    expect(isInsideWindow(NOON_UTC, '13:00', '15:00', 'Africa/Johannesburg')).toBe(true);
    expect(isInsideWindow(NOON_UTC, '13:00', '15:00', 'UTC')).toBe(false);
  });

  it('different timezones produce different inclusion at the same instant', () => {
    // At UTC 12:00:
    //   Tokyo (21:00) inside 18:00–23:00
    //   NY (08:00)    outside 18:00–23:00
    expect(isInsideWindow(NOON_UTC, '18:00', '23:00', 'Asia/Tokyo')).toBe(true);
    expect(isInsideWindow(NOON_UTC, '18:00', '23:00', 'America/New_York')).toBe(false);
  });
});

describe('isInsideWindow — degenerate windows', () => {
  it('zero-width window (from === to) is never inside', () => {
    // Same-day branch fires (from <= to), and nowHM >= from && nowHM < to
    // is impossible when from === to.
    expect(isInsideWindow(NOON_UTC, '14:00', '14:00', 'Africa/Johannesburg')).toBe(false);
  });
});
