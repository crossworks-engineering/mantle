import { describe, expect, it } from 'vitest';
import { CAPACITY_POLICY, capacityZone, computeCapacity } from './capacity';

describe('capacityZone', () => {
  const limits = { watch: 10, split: 20 };
  it('is green below watch', () => {
    expect(capacityZone(0, limits)).toBe('green');
    expect(capacityZone(9, limits)).toBe('green');
  });
  it('is watch from the watch threshold (inclusive)', () => {
    expect(capacityZone(10, limits)).toBe('watch');
    expect(capacityZone(19, limits)).toBe('watch');
  });
  it('is split from the split threshold (inclusive) and beyond', () => {
    expect(capacityZone(20, limits)).toBe('split');
    expect(capacityZone(1000, limits)).toBe('split');
  });
});

describe('computeCapacity', () => {
  it('reports both axes against the published policy', () => {
    const c = computeCapacity(3_000, 15_000);
    expect(c.docs).toMatchObject({ count: 3_000, ...CAPACITY_POLICY.docs, zone: 'green' });
    expect(c.chunkVectors).toMatchObject({
      count: 15_000,
      ...CAPACITY_POLICY.chunkVectors,
      zone: 'green',
    });
    expect(c.zone).toBe('green');
    expect(c.pctOfSplit).toBe(15); // docs 15% vs chunks 15% — equal, worst = 15
  });

  it('headline zone is the WORST axis (chunk-heavy corpora hit vectors first)', () => {
    const c = computeCapacity(4_000, 60_000); // docs green, chunks watch
    expect(c.docs.zone).toBe('green');
    expect(c.chunkVectors.zone).toBe('watch');
    expect(c.zone).toBe('watch');
    expect(c.pctOfSplit).toBe(60);
  });

  it('worst axis drives pctOfSplit even when zones agree', () => {
    const c = computeCapacity(5_000, 30_000); // 25% vs 30%
    expect(c.pctOfSplit).toBe(30);
  });

  it('split zone and >100% when the split point is passed', () => {
    const c = computeCapacity(25_000, 10_000);
    expect(c.docs.zone).toBe('split');
    expect(c.zone).toBe('split');
    expect(c.pctOfSplit).toBe(125);
  });

  it('zero corpus is green at 0%', () => {
    const c = computeCapacity(0, 0);
    expect(c.zone).toBe('green');
    expect(c.pctOfSplit).toBe(0);
  });
});
