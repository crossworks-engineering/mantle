/**
 * The ocr-rescan cost estimate (lib/maintenance/ocr-rescan.ts). Pure: the
 * dry run's number is what an operator approves spend on, so its arithmetic
 * and its "unknown" cases are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { estimateOcrCost, MAX_OCR_PAGES, type ModelPrice } from './ocr-rescan';

const tokens = { in: 1000, out: 500, source: 'test' };
const cheap: ModelPrice = { inPerM: 0.25, outPerM: 1.5, source: 'live catalog' };
const dear: ModelPrice = { inPerM: 2, outPerM: 12, source: 'live catalog' };

describe('estimateOcrCost', () => {
  it('expects one native call per document, priced on every page', () => {
    const e = estimateOcrCost({
      pagesPerDoc: [1, 3],
      tokens,
      nativePrice: cheap,
      nativeAvailable: true,
      visionPrice: dear,
    });
    // 4 pages x (1000 x 0.25 + 500 x 1.5) / 1e6 = 0.004
    expect(e.native).toEqual({ calls: 2, usd: 0.004 });
    // 4 pages x (1000 x 2 + 500 x 12) / 1e6 = 0.032
    expect(e.raster).toEqual({ calls: 4, usd: 0.032 });
    expect(e.expectedUsd).toBeCloseTo(0.004);
    expect(e.worstUsd).toBeCloseTo(0.036);
  });

  it('caps page OCR at the extractor page cap per document', () => {
    const e = estimateOcrCost({
      pagesPerDoc: [MAX_OCR_PAGES + 15],
      tokens,
      nativePrice: null,
      nativeAvailable: false,
      visionPrice: dear,
    });
    expect(e.native).toBeNull();
    expect(e.raster.calls).toBe(MAX_OCR_PAGES);
    expect(e.expectedUsd).toBe(e.raster.usd);
    expect(e.worstUsd).toBe(e.raster.usd);
  });

  it('says unknown, never zero, when a model has no price', () => {
    const e = estimateOcrCost({
      pagesPerDoc: [2],
      tokens,
      nativePrice: null,
      nativeAvailable: true,
      visionPrice: dear,
    });
    expect(e.native?.usd).toBeNull();
    expect(e.expectedUsd).toBeNull();
    expect(e.worstUsd).toBeNull();
  });
});
