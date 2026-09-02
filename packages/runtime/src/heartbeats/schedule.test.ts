/**
 * Tests for schedule arithmetic. Schedule math is the kind of code
 * that "looks right" but produces subtle off-by-one bugs the second
 * a jitter or a notBefore floor enters the picture. Keeping the
 * regressions visible here so a future change can't quietly break
 * fire timing.
 */

import { describe, expect, it } from 'vitest';
import { computeNextFireAt, validateSchedule } from './schedule';

const ANCHOR = new Date('2026-05-19T10:00:00Z');

describe('computeNextFireAt — once', () => {
  it('returns the future fire-at when it is after the anchor', () => {
    const next = computeNextFireAt({
      schedule: { kind: 'once', at: '2026-05-20T09:00:00Z' },
      anchor: ANCHOR,
    });
    expect(next?.toISOString()).toBe('2026-05-20T09:00:00.000Z');
  });

  it('returns null when the fire-at is in the past relative to anchor', () => {
    const next = computeNextFireAt({
      schedule: { kind: 'once', at: '2026-05-18T09:00:00Z' },
      anchor: ANCHOR,
    });
    expect(next).toBeNull();
  });

  it('returns null when fire-at equals anchor (no further fires)', () => {
    const next = computeNextFireAt({
      schedule: { kind: 'once', at: ANCHOR.toISOString() },
      anchor: ANCHOR,
    });
    // 'once' returns null when t <= anchor — we already fired or are firing now.
    expect(next).toBeNull();
  });
});

describe('computeNextFireAt — interval', () => {
  it('adds the interval to anchor with no jitter', () => {
    const next = computeNextFireAt({
      schedule: { kind: 'interval', every_minutes: 60 },
      anchor: ANCHOR,
    });
    expect(next?.toISOString()).toBe('2026-05-19T11:00:00.000Z');
  });

  it('respects every_minutes of 1', () => {
    const next = computeNextFireAt({
      schedule: { kind: 'interval', every_minutes: 1 },
      anchor: ANCHOR,
    });
    expect(next?.toISOString()).toBe('2026-05-19T10:01:00.000Z');
  });

  it('zero jitter_minutes is identical to no jitter', () => {
    const a = computeNextFireAt({
      schedule: { kind: 'interval', every_minutes: 60, jitter_minutes: 0 },
      anchor: ANCHOR,
    });
    const b = computeNextFireAt({
      schedule: { kind: 'interval', every_minutes: 60 },
      anchor: ANCHOR,
    });
    expect(a?.toISOString()).toBe(b?.toISOString());
  });
});

describe('computeNextFireAt — interval jitter', () => {
  it('is deterministic for the same seed', () => {
    const a = computeNextFireAt({
      schedule: { kind: 'interval', every_minutes: 60, jitter_minutes: 10 },
      anchor: ANCHOR,
      seed: 'hb-abc:5',
    });
    const b = computeNextFireAt({
      schedule: { kind: 'interval', every_minutes: 60, jitter_minutes: 10 },
      anchor: ANCHOR,
      seed: 'hb-abc:5',
    });
    expect(a?.toISOString()).toBe(b?.toISOString());
  });

  it('differs for different seeds', () => {
    const a = computeNextFireAt({
      schedule: { kind: 'interval', every_minutes: 60, jitter_minutes: 10 },
      anchor: ANCHOR,
      seed: 'hb-1:1',
    });
    const b = computeNextFireAt({
      schedule: { kind: 'interval', every_minutes: 60, jitter_minutes: 10 },
      anchor: ANCHOR,
      seed: 'hb-2:1',
    });
    expect(a?.toISOString()).not.toBe(b?.toISOString());
  });

  it('stays within ±magnitude bound', () => {
    // 60min base + jitter of 10min → result is in [50min, 70min] from anchor.
    const lo = ANCHOR.getTime() + 50 * 60_000;
    const hi = ANCHOR.getTime() + 70 * 60_000;
    for (let i = 0; i < 50; i++) {
      const next = computeNextFireAt({
        schedule: { kind: 'interval', every_minutes: 60, jitter_minutes: 10 },
        anchor: ANCHOR,
        seed: `seed-${i}`,
      });
      expect(next!.getTime()).toBeGreaterThanOrEqual(lo);
      expect(next!.getTime()).toBeLessThanOrEqual(hi);
    }
  });
});

describe('computeNextFireAt — manual', () => {
  it('returns null (heartbeat_fire tool is the only trigger)', () => {
    const next = computeNextFireAt({ schedule: { kind: 'manual' }, anchor: ANCHOR });
    expect(next).toBeNull();
  });
});

describe('computeNextFireAt — cron', () => {
  it('throws — reserved for v1.1', () => {
    expect(() =>
      computeNextFireAt({ schedule: { kind: 'cron', expr: '0 9 * * *' }, anchor: ANCHOR }),
    ).toThrow(/cron schedule/i);
  });
});

describe('computeNextFireAt — notBefore floor', () => {
  it('clamps an interval candidate up to notBefore', () => {
    // every_minutes=10 from ANCHOR → 10:10. notBefore=12:00 → 12:00 wins.
    const notBefore = new Date('2026-05-19T12:00:00Z');
    const next = computeNextFireAt({
      schedule: { kind: 'interval', every_minutes: 10 },
      anchor: ANCHOR,
      notBefore,
    });
    expect(next?.toISOString()).toBe(notBefore.toISOString());
  });

  it('leaves the candidate alone when it is already past notBefore', () => {
    const notBefore = new Date('2026-05-19T09:00:00Z'); // before ANCHOR
    const next = computeNextFireAt({
      schedule: { kind: 'interval', every_minutes: 10 },
      anchor: ANCHOR,
      notBefore,
    });
    expect(next?.toISOString()).toBe('2026-05-19T10:10:00.000Z');
  });

  it('does NOT push a null result up to notBefore (manual stays null)', () => {
    const notBefore = new Date('2026-05-19T12:00:00Z');
    const next = computeNextFireAt({
      schedule: { kind: 'manual' },
      anchor: ANCHOR,
      notBefore,
    });
    expect(next).toBeNull();
  });
});

describe('validateSchedule', () => {
  it('accepts a valid interval', () => {
    expect(() => validateSchedule({ kind: 'interval', every_minutes: 60 })).not.toThrow();
  });

  it('accepts interval with jitter <= half', () => {
    expect(() =>
      validateSchedule({ kind: 'interval', every_minutes: 60, jitter_minutes: 30 }),
    ).not.toThrow();
  });

  it('rejects interval with jitter > half of every_minutes', () => {
    expect(() =>
      validateSchedule({ kind: 'interval', every_minutes: 60, jitter_minutes: 31 }),
    ).toThrow(/half of every_minutes/i);
  });

  it('rejects interval with every_minutes < 1', () => {
    expect(() => validateSchedule({ kind: 'interval', every_minutes: 0 })).toThrow(/>= 1/);
  });

  it('rejects negative jitter', () => {
    expect(() =>
      validateSchedule({ kind: 'interval', every_minutes: 60, jitter_minutes: -1 }),
    ).toThrow(/>= 0/);
  });

  it('accepts a valid once', () => {
    expect(() => validateSchedule({ kind: 'once', at: '2026-12-31T23:59:00Z' })).not.toThrow();
  });

  it('rejects once with no at', () => {
    expect(() => validateSchedule({ kind: 'once', at: '' })).toThrow(/at/);
  });

  it('rejects once with unparseable at', () => {
    expect(() => validateSchedule({ kind: 'once', at: 'tomorrow' })).toThrow(/at/);
  });

  it('accepts manual', () => {
    expect(() => validateSchedule({ kind: 'manual' })).not.toThrow();
  });

  it('rejects cron in v1', () => {
    expect(() => validateSchedule({ kind: 'cron', expr: '0 9 * * *' })).toThrow(/cron/i);
  });
});
