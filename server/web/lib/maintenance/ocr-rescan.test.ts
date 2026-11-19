/**
 * The ocr-rescan cost estimate (lib/maintenance/ocr-rescan.ts). Pure: the
 * dry run's number is what an operator approves spend on, so its arithmetic
 * and its "unknown" cases are pinned here. The read is the Scan reader's,
 * every page, with no page cap; vision only for a page mostly a figure.
 */
import { describe, expect, it } from 'vitest';
import {
  estimateOcrCost,
  SCAN_READER_PAGE_USD,
  SCAN_READER_PAGE_USD_MAX,
  type ModelPrice,
} from './ocr-rescan';

const tokens = { in: 1000, out: 500, source: 'test' };
const dear: ModelPrice = { inPerM: 2, outPerM: 12, source: 'live catalog' };

describe('estimateOcrCost', () => {
  it('expects one Scan reader call a page, every page, with no cap', () => {
    const e = estimateOcrCost({
      pagesPerDoc: [1, 3, 400],
      tokens,
      scanReader: true,
      visionPrice: dear,
    });
    expect(e.scan).toEqual({ calls: 404, usd: 404 * SCAN_READER_PAGE_USD });
    expect(e.expectedUsd).toBeCloseTo(404 * SCAN_READER_PAGE_USD);
    // Worst: every page a figure, one vision call more a page, at the US
    // price: 404 x (0.0022 + (1000 x 2 + 500 x 12) / 1e6).
    expect(e.worstUsd).toBeCloseTo(404 * (SCAN_READER_PAGE_USD_MAX + 0.008));
  });

  it('says nothing is read with no Scan reader', () => {
    const e = estimateOcrCost({ pagesPerDoc: [2], tokens, scanReader: false, visionPrice: dear });
    expect(e).toEqual({ scan: null, expectedUsd: null, worstUsd: null });
  });

  it('says the worst case is unknown, never zero, when vision has no price', () => {
    const e = estimateOcrCost({ pagesPerDoc: [2], tokens, scanReader: true, visionPrice: null });
    expect(e.expectedUsd).toBeCloseTo(2 * SCAN_READER_PAGE_USD);
    expect(e.worstUsd).toBeNull();
  });
});
