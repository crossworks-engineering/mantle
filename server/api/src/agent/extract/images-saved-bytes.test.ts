/**
 * A picture read from disk whose spool was dropped (another read of the same
 * bytes was done with it) is a failed save, counted as one not kept: never
 * an empty picture saved as the page, which would then count as pictured
 * and never be drawn again.
 */
import { describe, expect, it } from 'vitest';
import { savedBytesOf, withoutVisionPageScans } from './images';

describe('the bytes of a picture to save', () => {
  it('a picture on disk is saved; one gone from disk is a failed save', () => {
    expect(savedBytesOf({ bytes: Buffer.from('png') }).toString()).toBe('png');
    expect(() => savedBytesOf({ bytes: Buffer.alloc(0) })).toThrow(/no longer on disk/);
  });
});

describe("a book's pictures of a page left to vision (G1)", () => {
  const img = (page: number | undefined, pageCover?: number) => ({
    ...(page !== undefined ? { location: { page } } : {}),
    ...(pageCover !== undefined ? { pageCover } : {}),
  });
  it('those that cover half the page or more together go; a figure, another page, an unknown cover stay', () => {
    const scan = img(3, 1);
    const strips = [img(5, 0.3), img(5, 0.3)];
    const figure = img(7, 0.2);
    const ocrPageScan = img(9, 1);
    const unknown = img(11);
    const noPage = img(undefined, 1);
    const kept = withoutVisionPageScans(
      [scan, ...strips, figure, ocrPageScan, unknown, noPage],
      new Set([3, 5, 7, 11]),
    );
    expect(kept).toEqual([figure, ocrPageScan, unknown, noPage]);
  });
});
