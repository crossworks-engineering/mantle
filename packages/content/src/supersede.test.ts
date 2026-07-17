import { describe, expect, it } from 'vitest';
import { salienceForSupersedeReason, wouldCreateSupersedeCycle } from './supersede';

/**
 * The pure halves of the supersession write path (house style: DB wrappers are
 * verified live; the logic that decides what they may write is unit-tested).
 * The cycle guard is the invariant every read-path walk relies on — a cycle
 * that slipped in would turn the bounded successor resolution into a cap-hit
 * on every query touching the family.
 */

describe('wouldCreateSupersedeCycle', () => {
  const edges = (pairs: Array<[string, string]>) => new Map(pairs);

  it('rejects the degenerate self-mark', () => {
    expect(wouldCreateSupersedeCycle(edges([]), 'a', 'a')).toBe(true);
  });

  it('allows a fresh mark onto an unmarked successor', () => {
    expect(wouldCreateSupersedeCycle(edges([]), 'a', 'b')).toBe(false);
  });

  it('allows extending a chain forward (a→b when b→c exists)', () => {
    expect(wouldCreateSupersedeCycle(edges([['b', 'c']]), 'a', 'b')).toBe(false);
  });

  it('rejects the 2-cycle (b→a exists, marking a→b)', () => {
    expect(wouldCreateSupersedeCycle(edges([['b', 'a']]), 'a', 'b')).toBe(true);
  });

  it('rejects a transitive cycle (b→c→a exists, marking a→b)', () => {
    expect(
      wouldCreateSupersedeCycle(
        edges([
          ['b', 'c'],
          ['c', 'a'],
        ]),
        'a',
        'b',
      ),
    ).toBe(true);
  });

  it('an under-sized cap ACCEPTS a deep cycle — which is why supersedeNode passes an exact one', () => {
    // Chain b→c→d→e→f→g→a: with cap 5 the walk stops before reaching 'a' and
    // the closing mark a→b reads as safe (returns false) — the unsafe
    // direction. supersedeNode therefore preloads the FULL chain and passes
    // cap = chain.size + 1, which catches the cycle exactly.
    const long = edges([
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'e'],
      ['e', 'f'],
      ['f', 'g'],
      ['g', 'a'],
    ]);
    expect(wouldCreateSupersedeCycle(long, 'a', 'b', 5)).toBe(false);
    expect(wouldCreateSupersedeCycle(long, 'a', 'b', long.size + 1)).toBe(true);
    expect(wouldCreateSupersedeCycle(long, 'a', 'b', 10)).toBe(true);
  });
});

describe('salienceForSupersedeReason', () => {
  it('demotes corrections harder than versions/migrations', () => {
    expect(salienceForSupersedeReason('corrected')).toBeLessThan(
      salienceForSupersedeReason('version'),
    );
    expect(salienceForSupersedeReason('migrated')).toBe(salienceForSupersedeReason('version'));
  });

  it('stays a down-weight, never a hide (0 < s < 1)', () => {
    for (const r of ['version', 'migrated', 'corrected'] as const) {
      const s = salienceForSupersedeReason(r);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    }
  });
});
