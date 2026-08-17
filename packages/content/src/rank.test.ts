import { describe, expect, it } from 'vitest';
import { isValidRank, rankBetween, ranksAfter } from './rank';

describe('rankBetween', () => {
  it('produces a key with both ends open', () => {
    expect(rankBetween(null, null)).toBe('i');
  });

  it('stays strictly between its bounds', () => {
    const cases: Array<[string | null, string | null]> = [
      [null, 'i'],
      ['i', null],
      ['a', 'b'],
      ['a', 'a1'],
      ['az', 'b'],
      ['z', null],
      ['zz', null],
      ['0z', '1'],
      ['abc', 'abd'],
    ];
    for (const [lo, hi] of cases) {
      const mid = rankBetween(lo, hi);
      if (lo) expect(mid > lo, `${mid} > ${lo}`).toBe(true);
      if (hi) expect(mid < hi, `${mid} < ${hi}`).toBe(true);
      expect(isValidRank(mid)).toBe(true);
    }
  });

  it('never emits a key ending in 0 (keeps every gap divisible)', () => {
    let lo: string | null = null;
    let hi: string | null = 'z';
    for (let i = 0; i < 200; i++) {
      const mid: string = rankBetween(lo, hi);
      expect(mid.endsWith('0')).toBe(false);
      // Halve toward the lower bound — the worst case for key growth.
      hi = mid;
    }
  });

  it('survives repeated insertion at the same point', () => {
    // Simulates dragging many cards between the same two neighbours.
    let a: string = rankBetween(null, null);
    let b: string = rankBetween(a, null);
    for (let i = 0; i < 100; i++) {
      const mid: string = rankBetween(a, b);
      expect(mid > a && mid < b).toBe(true);
      a = mid;
    }
  });

  it('rejects out-of-order or malformed bounds', () => {
    expect(() => rankBetween('b', 'a')).toThrow();
    expect(() => rankBetween('a', 'a')).toThrow();
    expect(() => rankBetween('A', null)).toThrow();
    expect(() => rankBetween(null, 'a!')).toThrow();
  });
});

describe('ranksAfter', () => {
  it('returns ascending keys after the anchor', () => {
    const keys = ranksAfter('i', 5);
    expect(keys).toHaveLength(5);
    let prev = 'i';
    for (const k of keys) {
      expect(k > prev).toBe(true);
      prev = k;
    }
  });
});

describe('isValidRank', () => {
  it('accepts base36 keys and rejects everything else', () => {
    expect(isValidRank('a0z9')).toBe(true);
    expect(isValidRank('')).toBe(false);
    expect(isValidRank('A')).toBe(false);
    expect(isValidRank(42)).toBe(false);
    expect(isValidRank('x'.repeat(65))).toBe(false);
  });
});
