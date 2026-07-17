import { describe, expect, it } from 'vitest';
import {
  isBackupDue,
  isResolvedBackupDirPersistent,
  normalizeBackupConfig,
  parseProcMounts,
  type BackupConfig,
} from './backup';

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

// A representative container /proc/self/mounts: overlay root, a couple of
// pseudo-filesystems, and an ext4 host bind-mount at /data/backups.
const CONTAINER_MOUNTS = [
  'overlay / overlay rw,relatime,lowerdir=/a,upperdir=/b 0 0',
  'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
  'tmpfs /dev tmpfs rw,nosuid,size=65536k 0 0',
  '/dev/sda1 /data/backups ext4 rw,relatime 0 0',
].join('\n');

// A native-Linux root (ext4), no overlay anywhere → not a container.
const HOST_MOUNTS = ['/dev/sda1 / ext4 rw,relatime 0 0', 'proc /proc proc rw 0 0'].join('\n');

describe('isResolvedBackupDirPersistent', () => {
  it('overlay root + dir under no bind mount → NOT persistent', () => {
    // /data/backups is a bind mount but /var/backups is only covered by '/'.
    expect(isResolvedBackupDirPersistent('/var/backups', CONTAINER_MOUNTS, true)).toBe(false);
    expect(isResolvedBackupDirPersistent('/root/dumps', CONTAINER_MOUNTS, true)).toBe(false);
  });

  it('tmpfs / ramfs mount winning → NOT persistent (RAM dies on recreate)', () => {
    const mounts = [
      'overlay / overlay rw 0 0',
      'tmpfs /dev/shm tmpfs rw,nosuid,nodev 0 0',
      'ramfs /run/keys ramfs rw 0 0',
      '/dev/sda1 /data/backups ext4 rw,relatime 0 0',
    ].join('\n');
    // A backup dir on a RAM-backed mount is just as ephemeral as the overlay.
    expect(isResolvedBackupDirPersistent('/dev/shm/mantle', mounts, true)).toBe(false);
    expect(isResolvedBackupDirPersistent('/run/keys/dumps', mounts, true)).toBe(false);
    // The ext4 bind mount alongside them is still persistent.
    expect(isResolvedBackupDirPersistent('/data/backups', mounts, true)).toBe(true);
  });

  it('dir under an ext4 bind-mounted path → persistent', () => {
    expect(isResolvedBackupDirPersistent('/data/backups', CONTAINER_MOUNTS, true)).toBe(true);
    expect(isResolvedBackupDirPersistent('/data/backups/nightly', CONTAINER_MOUNTS, true)).toBe(
      true,
    );
  });

  it('segment boundary: a /data/back mount must not claim /data/backups-x', () => {
    const mounts = [
      'overlay / overlay rw 0 0',
      '/dev/sda1 /data/back ext4 rw 0 0', // shorter, string-prefix but not a segment ancestor
    ].join('\n');
    // /data/backups-x is only covered by the overlay root → ephemeral.
    expect(isResolvedBackupDirPersistent('/data/backups-x', mounts, true)).toBe(false);
    // The genuine child of the ext4 mount is still persistent.
    expect(isResolvedBackupDirPersistent('/data/back/x', mounts, true)).toBe(true);
  });

  it('handles octal-escaped mountpoints (space → \\040)', () => {
    const mounts = ['overlay / overlay rw 0 0', '/dev/sda1 /data/my\\040backups ext4 rw 0 0'].join(
      '\n',
    );
    expect(isResolvedBackupDirPersistent('/data/my backups/db', mounts, true)).toBe(true);
    // The parser decodes the escape so the raw path never matches.
    const parsed = parseProcMounts(mounts);
    expect(parsed[1]?.mountpoint).toBe('/data/my backups');
  });

  it('non-container environment → always persistent, whatever the dir', () => {
    expect(isResolvedBackupDirPersistent('/anywhere/at/all', HOST_MOUNTS, false)).toBe(true);
    expect(isResolvedBackupDirPersistent('/tmp/x', null, false)).toBe(true);
  });

  it('container but mounts unreadable → fail OPEN (persistent)', () => {
    // dockerEnv true, mounts null (read failed) — never brick backups.
    expect(isResolvedBackupDirPersistent('/whatever', null, true)).toBe(true);
  });
});
