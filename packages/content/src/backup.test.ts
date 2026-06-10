import { describe, expect, it } from 'vitest';
import { isBackupDue, normalizeBackupConfig, type BackupConfig } from './backup';

const cfg = (over: Partial<BackupConfig> = {}): BackupConfig => ({
  enabled: true,
  frequency: 'daily',
  hour: 2,
  keep: 7,
  ...over,
});

// 2026-06-10 is a Wednesday. 00:00 UTC = 02:00 in Africa/Johannesburg (+02).
const JNB = 'Africa/Johannesburg';
const WED_02H_JNB = new Date('2026-06-10T00:30:00Z');
const SUN_02H_JNB = new Date('2026-06-07T00:30:00Z');

describe('isBackupDue', () => {
  it('never due when disabled', () => {
    expect(isBackupDue(cfg({ enabled: false }), null, WED_02H_JNB, JNB)).toBe(false);
  });

  it('due at the configured hour in the USER timezone, not UTC', () => {
    // 00:30 UTC is 02:30 in Johannesburg — hour 2 matches there, not in UTC.
    expect(isBackupDue(cfg(), null, WED_02H_JNB, JNB)).toBe(true);
    expect(isBackupDue(cfg(), null, WED_02H_JNB, 'UTC')).toBe(false);
  });

  it('not due outside the configured hour', () => {
    expect(isBackupDue(cfg(), null, new Date('2026-06-10T10:30:00Z'), JNB)).toBe(false);
  });

  it('double-fire guard: a run earlier in the same window blocks a second', () => {
    const lastRun = new Date(WED_02H_JNB.getTime() - 10 * 60_000).toISOString();
    expect(isBackupDue(cfg(), lastRun, WED_02H_JNB, JNB)).toBe(false);
  });

  it("yesterday's run does not block today's window", () => {
    const lastRun = new Date(WED_02H_JNB.getTime() - 24 * 3600_000).toISOString();
    expect(isBackupDue(cfg(), lastRun, WED_02H_JNB, JNB)).toBe(true);
  });

  it('weekly fires only on Sundays', () => {
    expect(isBackupDue(cfg({ frequency: 'weekly' }), null, SUN_02H_JNB, JNB)).toBe(true);
    expect(isBackupDue(cfg({ frequency: 'weekly' }), null, WED_02H_JNB, JNB)).toBe(false);
  });

  it('weekly double-fire guard spans the week, not just a day', () => {
    const twoDaysAgo = new Date(SUN_02H_JNB.getTime() - 2 * 24 * 3600_000).toISOString();
    const lastWeek = new Date(SUN_02H_JNB.getTime() - 7 * 24 * 3600_000).toISOString();
    expect(isBackupDue(cfg({ frequency: 'weekly' }), twoDaysAgo, SUN_02H_JNB, JNB)).toBe(false);
    expect(isBackupDue(cfg({ frequency: 'weekly' }), lastWeek, SUN_02H_JNB, JNB)).toBe(true);
  });
});

describe('normalizeBackupConfig', () => {
  it('defaults garbage to the safe config', () => {
    expect(normalizeBackupConfig(undefined)).toEqual({
      enabled: false,
      frequency: 'daily',
      hour: 2,
      keep: 7,
      location: undefined,
    });
    expect(normalizeBackupConfig({ hour: 99, keep: -3, frequency: 'hourly' })).toMatchObject({
      frequency: 'daily',
      hour: 2,
      keep: 7,
    });
  });

  it('passes through a valid config and trims location', () => {
    expect(
      normalizeBackupConfig({
        enabled: true,
        frequency: 'weekly',
        hour: 23,
        keep: 30,
        location: '  /backups/mantle  ',
      }),
    ).toEqual({
      enabled: true,
      frequency: 'weekly',
      hour: 23,
      keep: 30,
      location: '/backups/mantle',
    });
  });

  it('treats empty location as unset', () => {
    expect(normalizeBackupConfig({ location: '   ' }).location).toBeUndefined();
  });
});
