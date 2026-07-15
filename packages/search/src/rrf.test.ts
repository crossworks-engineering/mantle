import { describe, expect, it } from 'vitest';
import { applyRescueFloor, fuseRrf, RRF_K } from './rrf';

describe('fuseRrf', () => {
  it('returns vector order when the FTS arm is empty (pure-vector degenerate case)', () => {
    const fused = fuseRrf(
      [
        { ids: ['a', 'b', 'c'], weight: 0.7 },
        { ids: [], weight: 0.3 },
      ],
      10,
    );
    expect(fused).toEqual(['a', 'b', 'c']);
  });

  it('an id ranked by both arms beats a same-rank id ranked by one', () => {
    const fused = fuseRrf(
      [
        { ids: ['both', 'vecOnly'], weight: 0.7 },
        { ids: ['both', 'ftsOnly'], weight: 0.3 },
      ],
      10,
    );
    expect(fused[0]).toBe('both');
  });

  it('documents the booster blind spot: an FTS-only hit cannot crack a small cut on weights alone', () => {
    const vectorIds = Array.from({ length: 50 }, (_, i) => `v${i}`);
    const fused = fuseRrf(
      [
        { ids: vectorIds, weight: 0.7 },
        { ids: ['needle'], weight: 0.3 },
      ],
      8,
    );
    // 0.3/(K+1) < 0.7/(K+50): the needle ranks below the ENTIRE vector pool.
    // This is the failure applyRescueFloor exists for — if this assertion ever
    // flips, the floor may be removable.
    expect(fused).not.toContain('needle');
  });

  it('caps at limit and keeps descending fused order', () => {
    const fused = fuseRrf(
      [
        { ids: ['a', 'b', 'c', 'd'], weight: 0.7 },
        { ids: ['c', 'a'], weight: 0.3 },
      ],
      2,
    );
    expect(fused).toHaveLength(2);
    expect(fused[0]).toBe('a'); // rank1 in both arms
  });

  it('duplicate ids within one arm keep their best rank only (no double-count)', () => {
    const withDup = fuseRrf([{ ids: ['a', 'a', 'b'], weight: 1 }], 10);
    expect(withDup).toEqual(['a', 'b']);
    // A second arm ranking 'b' first must still be able to overtake a
    // duplicated 'a' — i.e. 'a' gained nothing from appearing twice.
    const overtaken = fuseRrf(
      [
        { ids: ['a', 'a', 'b'], weight: 0.5 },
        { ids: ['b'], weight: 0.5 },
      ],
      10,
    );
    expect(overtaken[0]).toBe('b');
  });

  it('exposes the shared K constant searchNodes established', () => {
    expect(RRF_K).toBe(60);
  });
});

describe('applyRescueFloor', () => {
  it('lifts the booster top hits into the tail of the cut, preserving the head', () => {
    const fused = ['v1', 'v2', 'v3', 'v4', 'v5'];
    const out = applyRescueFloor(fused, ['needle'], 5, 2);
    expect(out).toEqual(['v1', 'v2', 'v3', 'v4', 'needle']);
  });

  it('is a no-op when the booster hits already made the cut', () => {
    const fused = ['needle', 'v1', 'v2'];
    expect(applyRescueFloor(fused, ['needle'], 3, 2)).toEqual(['needle', 'v1', 'v2']);
  });

  it('caps rescue at `slots` and never exceeds limit', () => {
    const fused = ['v1', 'v2', 'v3', 'v4'];
    const out = applyRescueFloor(fused, ['f1', 'f2', 'f3'], 4, 2);
    expect(out).toEqual(['v1', 'v2', 'f1', 'f2']);
  });

  it('handles a fused list shorter than limit (no padding beyond real hits)', () => {
    const out = applyRescueFloor(['v1'], ['f1'], 10, 2);
    expect(out).toEqual(['v1', 'f1']);
  });

  it('an empty booster arm returns the fused cut unchanged', () => {
    expect(applyRescueFloor(['v1', 'v2'], [], 2, 2)).toEqual(['v1', 'v2']);
  });
});
