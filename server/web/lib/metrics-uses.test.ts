import { describe, expect, it } from 'vitest';
import { attachUseSpend, type UseSpendRow } from './metrics-uses';
import type { ModelSpend } from '@mantle/client-types';

const model = (m: string, cost: number): ModelSpend => ({
  model: m,
  costMicroUsd: cost,
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  calls: 1,
});

const row = (p: Partial<UseSpendRow>): UseSpendRow => ({
  model: 'typesafe/jev-1.13',
  use: 'passage_scoring',
  costMicroUsd: 0,
  tokensIn: 0,
  calls: 0,
  failed: 0,
  msSum: 0,
  msCount: 0,
  ...p,
});

describe('attachUseSpend', () => {
  it('splits a decision model by use, most expensive first, with mean latency', () => {
    const out = attachUseSpend(
      [model('typesafe/jev-1.13', 900), model('google/gemini-3.1-flash-lite', 5000)],
      [
        row({ use: 'delegation_hint', costMicroUsd: 100, calls: 10, msSum: 3000, msCount: 10 }),
        row({
          use: 'context_pruning',
          costMicroUsd: 800,
          calls: 4,
          failed: 1,
          msSum: 1200,
          msCount: 3,
        }),
      ],
    );
    expect(out[0]!.uses).toEqual([
      { use: 'context_pruning', costMicroUsd: 800, tokensIn: 0, calls: 4, failed: 1, avgMs: 400 },
      { use: 'delegation_hint', costMicroUsd: 100, tokensIn: 0, calls: 10, failed: 0, avgMs: 300 },
    ]);
  });

  it('leaves models with no use rows untouched (no uses key)', () => {
    const chat = model('google/gemini-3.1-flash-lite', 5000);
    expect(attachUseSpend([chat], [row({})])[0]).toBe(chat);
  });

  it('reports no latency when no answered call carried one', () => {
    const out = attachUseSpend([model('typesafe/jev-1.13', 0)], [row({ calls: 2, failed: 2 })]);
    expect(out[0]!.uses![0]!.avgMs).toBeNull();
  });
});
