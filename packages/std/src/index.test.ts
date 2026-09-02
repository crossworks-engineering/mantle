import { describe, expect, it } from 'vitest';
import { errorMessage, isUuid, sleep, UUID_RE } from './index';

describe('@mantle/std', () => {
  it('errorMessage takes an Error message or stringifies anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
  });
  it('isUuid accepts either case and rejects near misses', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('11111111-1111-4111-8111-111111111111'.toUpperCase())).toBe(true);
    expect(isUuid('11111111-1111-4111-8111-11111111111')).toBe(false);
    expect(isUuid(' 11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(UUID_RE.flags).toBe('i');
  });
  it('sleep resolves after the delay', async () => {
    const t = Date.now();
    await sleep(15);
    expect(Date.now() - t).toBeGreaterThanOrEqual(10);
  });
});
