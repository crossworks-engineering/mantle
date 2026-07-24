import { describe, expect, it } from 'vitest';
import { nearestBlockIndex, type Span } from './gutter-geometry';

// Three blocks with a 10px gap between each.
const spans: Span[] = [
  { top: 0, bottom: 20 },
  { top: 30, bottom: 50 },
  { top: 60, bottom: 80 },
];

describe('nearestBlockIndex', () => {
  it('returns -1 when there are no blocks', () => {
    expect(nearestBlockIndex([], 10)).toBe(-1);
  });

  it('returns the block whose span contains y', () => {
    expect(nearestBlockIndex(spans, 10)).toBe(0);
    expect(nearestBlockIndex(spans, 40)).toBe(1);
    expect(nearestBlockIndex(spans, 70)).toBe(2);
  });

  it('clamps above the first block to index 0', () => {
    expect(nearestBlockIndex(spans, -100)).toBe(0);
  });

  it('clamps below the last block to the last index (not 0)', () => {
    expect(nearestBlockIndex(spans, 500)).toBe(spans.length - 1);
  });

  it('maps a gap to the NEAREST block, not a far clamp (the divider bug)', () => {
    // Gap between block 0 (…20) and block 1 (30…): 23 is nearer the top one.
    expect(nearestBlockIndex(spans, 23)).toBe(0);
    // 27 is nearer the lower one.
    expect(nearestBlockIndex(spans, 27)).toBe(1);
    // A gap late in the doc resolves to its neighbour — never block count-1
    // unless that's actually nearest (this is what stopped whole-doc marking).
    expect(nearestBlockIndex(spans, 53)).toBe(1);
  });
});
