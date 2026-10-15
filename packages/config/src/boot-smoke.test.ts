/**
 * MANTLE_BOOT_SMOKE takes one exact value (boot-smoke.ts). A flag word left
 * in a box's .env must not turn every container into one that exits 0 at
 * start and restarts forever.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BOOT_SMOKE_VALUE, isBootSmoke } from './boot-smoke';

const saved = process.env.MANTLE_BOOT_SMOKE;
afterEach(() => {
  if (saved === undefined) delete process.env.MANTLE_BOOT_SMOKE;
  else process.env.MANTLE_BOOT_SMOKE = saved;
});

describe('isBootSmoke', () => {
  it('is on only for the sentinel value', () => {
    expect(BOOT_SMOKE_VALUE).toBe('import-only');
    process.env.MANTLE_BOOT_SMOKE = 'import-only';
    expect(isBootSmoke()).toBe(true);
  });

  it('is off when unset', () => {
    delete process.env.MANTLE_BOOT_SMOKE;
    expect(isBootSmoke()).toBe(false);
  });

  it.each(['1', 'true', 'on', 'yes', 'TRUE', '', ' import-only', 'IMPORT-ONLY', 'import'])(
    'ignores %j',
    (value) => {
      process.env.MANTLE_BOOT_SMOKE = value;
      expect(isBootSmoke()).toBe(false);
    },
  );
});
