import { describe, expect, it, vi } from 'vitest';
import { errorMessage, isUuid, sleep, truncate, UUID_RE } from './index';

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

describe('truncate', () => {
  it('leaves a string at or under the cap alone', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('', 5)).toBe('');
  });

  it('never returns more than `max` characters — the ellipsis counts', () => {
    // The property callers depend on: `max` is a column width or a storage
    // limit, so a result of max+1 defeats the point of asking.
    const out = truncate('abcdefgh', 4);
    expect(out).toBe('abc…');
    expect([...out]).toHaveLength(4);
  });

  it('measures in UTF-16 units, as slice does', () => {
    // Worth stating rather than discovering: an emoji is two units, so a cut
    // can land mid-pair. Callers sizing a visual column should allow for it.
    expect(truncate('ab', 2)).toBe('ab');
    expect(truncate('abcd', 2)).toBe('a…');
  });
});

describe('database errors for callers outside the server', () => {
  it('knows a Postgres or drizzle error, also deep in the cause chain', async () => {
    const { isDatabaseError, publicErrorMessage, DATABASE_ERROR_PUBLIC } = await import('./index');
    const pg = Object.assign(new Error('bad'), { code: '22P02', severity: 'ERROR' });
    expect(isDatabaseError(pg)).toBe(true);
    expect(isDatabaseError(Object.assign(new Error('x'), { name: 'DrizzleQueryError' }))).toBe(
      true,
    );
    expect(isDatabaseError(new Error('wrap', { cause: new Error('mid', { cause: pg }) }))).toBe(
      true,
    );
    expect(isDatabaseError(new Error('node not found'))).toBe(false);
    expect(isDatabaseError(Object.assign(new Error('fs'), { code: 'ENOENT' }))).toBe(false);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(publicErrorMessage(pg, 't')).toBe(DATABASE_ERROR_PUBLIC);
    expect(publicErrorMessage(new Error('q is required'), 't')).toBe('q is required');
    spy.mockRestore();
  });
});
