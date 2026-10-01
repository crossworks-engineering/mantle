import { describe, expect, it } from 'vitest';

import { chooseApiVersion, compareApiVersion, PREFERRED_API_VERSION } from './api-version';

/**
 * The daemon's accepted API range moves between Docker releases (29.0/29.1
 * raised the minimum to 1.44; 29.5.2 lowered it to 1.40). A wrong clamp here
 * means every docker call fails and /healthz goes 503, so the real ranges are
 * pinned.
 */
describe('chooseApiVersion clamps the preferred version into the daemon range', () => {
  it('prefers 1.43', () => {
    expect(PREFERRED_API_VERSION).toBe('1.43');
  });

  it('raises to the minimum on Docker 29.1 (min 1.44, max 1.52)', () => {
    expect(chooseApiVersion({ MinAPIVersion: '1.44', ApiVersion: '1.52' })).toBe('1.44');
  });

  it('keeps 1.43 when the range allows it (min 1.40, max 1.54)', () => {
    expect(chooseApiVersion({ MinAPIVersion: '1.40', ApiVersion: '1.54' })).toBe('1.43');
  });

  it('lowers to the maximum on an old daemon (max 1.41)', () => {
    expect(chooseApiVersion({ MinAPIVersion: '1.12', ApiVersion: '1.41' })).toBe('1.41');
  });

  it('ignores missing or malformed bounds', () => {
    expect(chooseApiVersion({})).toBe('1.43');
    expect(chooseApiVersion({ MinAPIVersion: 'nope', ApiVersion: 152 })).toBe('1.43');
    expect(chooseApiVersion({ MinAPIVersion: '1.44' })).toBe('1.44');
  });
});

describe('compareApiVersion', () => {
  it('compares minor versions numerically, not as floats', () => {
    expect(compareApiVersion('1.9', '1.10')).toBeLessThan(0);
    expect(compareApiVersion('1.44', '1.43')).toBeGreaterThan(0);
    expect(compareApiVersion('1.43', '1.43')).toBe(0);
  });
});
