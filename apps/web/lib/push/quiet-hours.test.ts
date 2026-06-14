import { describe, it, expect } from 'vitest';
import { isQuietNow, type QuietHours } from './quiet-hours';

const base: QuietHours = {
  quietEnabled: true,
  quietStart: '22:00',
  quietEnd: '07:00',
  timezone: 'UTC',
};

// A UTC instant at a given hour:min, so timezone math is deterministic.
function at(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 0, 1, hour, minute, 0));
}

describe('isQuietNow', () => {
  it('is never quiet when disabled', () => {
    expect(isQuietNow({ ...base, quietEnabled: false }, at(23))).toBe(false);
  });

  it('wraps past midnight (22:00 → 07:00)', () => {
    expect(isQuietNow(base, at(23))).toBe(true); // late evening
    expect(isQuietNow(base, at(2))).toBe(true); // early morning
    expect(isQuietNow(base, at(22, 0))).toBe(true); // inclusive start
    expect(isQuietNow(base, at(6, 59))).toBe(true); // just before end
    expect(isQuietNow(base, at(7, 0))).toBe(false); // exclusive end
    expect(isQuietNow(base, at(12))).toBe(false); // midday
  });

  it('handles a same-day window (09:00 → 17:00)', () => {
    const day: QuietHours = { ...base, quietStart: '09:00', quietEnd: '17:00' };
    expect(isQuietNow(day, at(12))).toBe(true);
    expect(isQuietNow(day, at(8))).toBe(false);
    expect(isQuietNow(day, at(17))).toBe(false);
  });

  it('a zero-length window is never quiet', () => {
    expect(isQuietNow({ ...base, quietStart: '12:00', quietEnd: '12:00' }, at(12))).toBe(false);
  });

  it('respects the timezone (07:00 UTC = 09:00 in +02:00)', () => {
    const jhb: QuietHours = { ...base, timezone: 'Africa/Johannesburg' }; // UTC+2, no DST
    // 06:00 UTC = 08:00 JHB → within 22:00–07:00? 08:00 is NOT quiet.
    expect(isQuietNow(jhb, at(6))).toBe(false);
    // 21:00 UTC = 23:00 JHB → quiet.
    expect(isQuietNow(jhb, at(21))).toBe(true);
  });

  it('falls back to UTC for an unknown timezone', () => {
    expect(isQuietNow({ ...base, timezone: 'Not/AZone' }, at(23))).toBe(true);
  });
});
