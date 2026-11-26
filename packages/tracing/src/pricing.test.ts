import { describe, expect, it } from 'vitest';
import {
  fallbackCostMicroUsd,
  isFreeCall,
  listPriceMicroUsd,
  priceKey,
  PRICED_MODEL_IDS,
} from './pricing';

describe('fallbackCostMicroUsd', () => {
  it('prices every decision model that answers a full-size request', () => {
    // Groups A and B of the 2026-10-30 probe. A call that reports no
    // usage.cost prices from these rows, or its spend reads $0.
    for (const id of [
      '~typesafe/jev-latest',
      'typesafe/jev-1.14',
      'typesafe/jev-1.13',
      'perplexity/pplx-decider-v1.2',
      'microsoft/microsoft-decision-1',
      'nace-ai/drex-v1.5',
      'cloudflare/clef-omni',
      'openai/gpt-6-luna-decisions',
      'respan/span-02',
    ]) {
      expect(fallbackCostMicroUsd(id, { input: 1_000_000, output: 0 }), id).toBeGreaterThan(0);
    }
    // Luna: $0.10 per 1M input tokens.
    expect(
      fallbackCostMicroUsd('openai/gpt-6-luna-decisions', { input: 1_000_000, output: 0 }),
    ).toBe(100_000);
  });

  it('prices a known OpenRouter slug (result is micro-USD)', () => {
    // gpt-4o-mini: input $0.00000015/tok, output $0.0000006/tok.
    // 1M input tokens = $0.15 = 150_000 µ$; 1M output = $0.60 = 600_000 µ$.
    expect(fallbackCostMicroUsd('openai/gpt-4o-mini', { input: 1_000_000, output: 0 })).toBe(
      150_000,
    );
    expect(fallbackCostMicroUsd('openai/gpt-4o-mini', { input: 0, output: 1_000_000 })).toBe(
      600_000,
    );
  });

  it('prices the BARE OpenAI id direct adapters pass (file-ingestion.md V1)', () => {
    // The default vision worker is provider=openai, model=gpt-4o-mini — the
    // direct adapter passes the bare id, not the openai/ slug. Before the V1
    // fix this fell through to $0 and vision spend was invisible in /debug.
    const bare = fallbackCostMicroUsd('gpt-4o-mini', { input: 25_579, output: 48 });
    expect(bare).toBeGreaterThan(0);
    // Parity with the OpenRouter-slugged entry — same price either way.
    expect(bare).toBe(fallbackCostMicroUsd('openai/gpt-4o-mini', { input: 25_579, output: 48 }));
  });

  it('prices the BARE Claude id the direct vision/document adapter passes', () => {
    // The dedicated Document worker is provider=anthropic, model=claude-sonnet-4-6
    // — the direct adapter passes the bare id (not anthropic/claude-sonnet-4.6),
    // which used to fall through to $0 (native-PDF cost invisible in /debug).
    const bare = fallbackCostMicroUsd('claude-sonnet-4-6', { input: 8010, output: 2370 });
    expect(bare).toBeGreaterThan(0);
    // Parity with the OpenRouter-slugged entry — same rates either way.
    expect(bare).toBe(
      fallbackCostMicroUsd('anthropic/claude-sonnet-4.6', { input: 8010, output: 2370 }),
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

  it('one row per model: the vendor prefix, a `~` and the dot spelling do not matter', () => {
    const tokens = { input: 1_000_000, output: 1_000_000 };
    for (const [a, b] of [
      ['openai/text-embedding-3-large', 'text-embedding-3-large'],
      ['openai/text-embedding-3-small', 'text-embedding-3-small'],
      ['anthropic/claude-sonnet-5.5', 'claude-sonnet-5-5'],
      ['anthropic/claude-haiku-5.5', 'claude-haiku-5-5'],
      ['anthropic/claude-opus-5.5', 'claude-opus-5-5'],
      ['deepseek/deepseek-chat', 'deepseek-chat'],
      ['google/gemini-2.5-flash', 'gemini-2.5-flash'],
      ['google/gemini-3.8-flash', '~google/gemini-3.8-flash'],
      ['x-ai/grok-4.7', 'grok-4.7'],
    ] as const) {
      const price = fallbackCostMicroUsd(a, tokens);
      expect(price, a).toBeGreaterThan(0);
      expect(fallbackCostMicroUsd(b, tokens), b).toBe(price);
    }
  });

  it('no two rows share a key (a second spelling of a model is not a second row)', () => {
    const keys = PRICED_MODEL_IDS.map(priceKey);
    const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(twice).toEqual([]);
  });

  it('says a model has no row with null, not with $0', () => {
    expect(listPriceMicroUsd('some/unlisted-model', { input: 1000, output: 1000 })).toBeNull();
    expect(listPriceMicroUsd('openai/gpt-4o-mini', { input: 0, output: 0 })).toBe(0);
    // A unit row prices its own unit only.
    const none = { input: 0, output: 0 };
    expect(listPriceMicroUsd('grok-stt', none, { kind: 'audio_seconds', count: 3600 })).toBe(
      100_000,
    );
    expect(listPriceMicroUsd('grok-stt', none, { kind: 'characters', count: 3600 })).toBeNull();
    expect(listPriceMicroUsd('grok-stt', none)).toBeNull();
  });

  it('the free list: a self-hosted model and a `:free` id, nothing else', () => {
    expect(isFreeCall('local', 'embeddinggemma:latest')).toBe(true);
    expect(isFreeCall('openrouter', 'made-up/model:free')).toBe(true);
    expect(isFreeCall('openrouter', 'made-up/model')).toBe(false);
    expect(isFreeCall('custom', 'made-up-model')).toBe(false);
  });
});
