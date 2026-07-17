import { describe, it, expect } from 'vitest';
import { str, strArr, strArrOpt } from './coerce';

describe('str', () => {
  it('passes strings through unchanged (no trimming)', () => {
    expect(str('hello')).toBe('hello');
    expect(str('  spaced  ')).toBe('  spaced  ');
    expect(str('')).toBe('');
  });

  it('coerces non-strings to the empty string', () => {
    expect(str(42)).toBe('');
    expect(str(null)).toBe('');
    expect(str(undefined)).toBe('');
    expect(str(['a'])).toBe('');
    expect(str({})).toBe('');
    expect(str(true)).toBe('');
  });
});

describe('strArr', () => {
  it('keeps only string members', () => {
    expect(strArr(['a', 1, 'b', null, 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('preserves empty-string members', () => {
    expect(strArr(['', 'a', ''])).toEqual(['', 'a', '']);
  });

  it('returns [] for a non-array (never undefined)', () => {
    expect(strArr(undefined)).toEqual([]);
    expect(strArr(null)).toEqual([]);
    expect(strArr('a')).toEqual([]);
    expect(strArr(5)).toEqual([]);
  });

  it('returns [] for an array with no strings', () => {
    expect(strArr([1, 2, null])).toEqual([]);
  });
});

describe('strArrOpt', () => {
  it('behaves like strArr but collapses "empty" to undefined', () => {
    expect(strArrOpt(['a', 'b'])).toEqual(['a', 'b']);
    expect(strArrOpt([1, 2])).toBeUndefined();
    expect(strArrOpt([])).toBeUndefined();
    expect(strArrOpt(undefined)).toBeUndefined();
    expect(strArrOpt('a')).toBeUndefined();
  });

  it('preserves empty-string members (they count as usable)', () => {
    // Matches the legacy tasks/events/peers behaviour: an array of empty
    // strings is non-empty, so it is returned as-is rather than undefined.
    expect(strArrOpt([''])).toEqual(['']);
  });
});
