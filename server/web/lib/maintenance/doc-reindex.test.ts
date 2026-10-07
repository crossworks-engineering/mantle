/**
 * The doc-reindex cost estimate (lib/maintenance/doc-reindex.ts). Pure: the
 * dry run's number is what an operator approves spend on, so its arithmetic
 * and its "unknown" case are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { ASSUMED_DOC_TOKENS, estimateDocReindexCost } from './doc-reindex';
import type { ModelPrice } from './ocr-rescan';

const cheap: ModelPrice = { inPerM: 0.1, outPerM: 0.4, source: 'live catalog' };

describe('estimateDocReindexCost', () => {
  it('prices from the box run history when it has one', () => {
    const e = estimateDocReindexCost({
      count: 365,
      history: { runs: 147, avgMicroUsd: 1601, maxMicroUsd: 2380, source: 'test' },
      price: cheap,
    });
    expect(e.expectedUsd).toBeCloseTo(0.584, 3);
    expect(e.worstUsd).toBeCloseTo(0.8687, 3);
    expect(e.basis).toBe('test');
  });

  it('falls back to the model price on the assumed tokens, worst case double', () => {
    const e = estimateDocReindexCost({ count: 100, history: null, price: cheap });
    const per = (ASSUMED_DOC_TOKENS.in * 0.1 + ASSUMED_DOC_TOKENS.out * 0.4) / 1e6;
    expect(e.expectedUsd).toBeCloseTo(100 * per);
    expect(e.worstUsd).toBeCloseTo(200 * per);
  });

  it('says unknown rather than guessing', () => {
    const e = estimateDocReindexCost({ count: 10, history: null, price: null });
    expect(e.expectedUsd).toBeNull();
    expect(e.worstUsd).toBeNull();
  });
});
