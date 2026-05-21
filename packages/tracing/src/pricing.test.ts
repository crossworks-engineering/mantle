import { describe, expect, it } from 'vitest';
import { fallbackCostMicroUsd } from './pricing';

describe('fallbackCostMicroUsd', () => {
  it('prices a known OpenRouter slug (result is micro-USD)', () => {
    // gpt-4o-mini: input $0.00000015/tok, output $0.0000006/tok.
    // 1M input tokens = $0.15 = 150_000 µ$; 1M output = $0.60 = 600_000 µ$.
    expect(fallbackCostMicroUsd('openai/gpt-4o-mini', { input: 1_000_000, output: 0 })).toBe(150_000);
    expect(fallbackCostMicroUsd('openai/gpt-4o-mini', { input: 0, output: 1_000_000 })).toBe(600_000);
  });

  it('prices the BARE OpenAI id direct adapters pass (file-ingestion.md V1)', () => {
    // The default vision worker is provider=openai, model=gpt-4o-mini — the
    // direct adapter passes the bare id, not the openai/ slug. Before the V1
    // fix this fell through to $0 and vision spend was invisible in /debug.
    const bare = fallbackCostMicroUsd('gpt-4o-mini', { input: 25_579, output: 48 });
    expect(bare).toBeGreaterThan(0);
    // Parity with the OpenRouter-slugged entry — same price either way.
    expect(bare).toBe(
      fallbackCostMicroUsd('openai/gpt-4o-mini', { input: 25_579, output: 48 }),
    );
  });

  it('is case-insensitive on the model slug', () => {
    expect(fallbackCostMicroUsd('GPT-4o-Mini', { input: 1_000_000, output: 0 })).toBe(150_000);
  });

  it('charges cached input at the cache rate when provided', () => {
    // sonnet-4.6: input $0.000003, cacheRead $0.0000003 (10x cheaper)
    const allFresh = fallbackCostMicroUsd('anthropic/claude-sonnet-4.6', {
      input: 1_000_000,
      output: 0,
    });
    const allCached = fallbackCostMicroUsd('anthropic/claude-sonnet-4.6', {
      input: 1_000_000,
      output: 0,
      cacheRead: 1_000_000,
    });
    expect(allFresh).toBe(3_000_000); // 1M tok × $0.000003 = $3.00
    expect(allCached).toBe(300_000); // 1M cached tok × $0.0000003 = $0.30
  });

  it('returns 0 for an unknown model rather than throwing', () => {
    expect(fallbackCostMicroUsd('some/unlisted-model', { input: 1000, output: 1000 })).toBe(0);
  });
});
