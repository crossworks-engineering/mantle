/**
 * Tests for the vision routing helpers used by the web /assistant and the
 * Telegram responder to decide whether to show a model a raw image.
 *
 * Why these matter: `maxImageBytesFor` is the size guard that keeps an
 * oversized photo from reaching Anthropic-via-Bedrock, which rejects images
 * over ~5 MB with an opaque "Could not process image" that the OpenRouter
 * SDK masks as a generic validation error → a hard 500 on the turn. Locking
 * the limits down here keeps that guard honest. `modelSupportsVision` gates
 * the same decision, so a regression in its family matching would silently
 * stop sending pictures (or send them to a text-only model).
 */

import { describe, expect, it } from 'vitest';
import {
  maxImageBytesFor,
  modelSupportsVision,
  parseCatalog,
  contextLimitFor,
  contextSourceFor,
} from './model-context';

describe('maxImageBytesFor', () => {
  it("keeps Anthropic under Bedrock's ~5 MB per-image cap", () => {
    expect(maxImageBytesFor('anthropic/claude-sonnet-4.6')).toBeLessThan(5_000_000);
    expect(maxImageBytesFor('anthropic/claude-opus-4.7')).toBe(4_500_000);
  });

  it('allows OpenAI a larger budget but stays under its 20 MB cap', () => {
    const limit = maxImageBytesFor('openai/gpt-4o');
    expect(limit).toBeGreaterThan(5_000_000);
    expect(limit).toBeLessThan(20_000_000);
  });

  it('falls back to the conservative Anthropic limit for unknown / null models', () => {
    expect(maxImageBytesFor('google/gemini-2.5-pro')).toBe(4_500_000);
    expect(maxImageBytesFor('some/unlisted-model')).toBe(4_500_000);
    expect(maxImageBytesFor(null)).toBe(4_500_000);
    expect(maxImageBytesFor(undefined)).toBe(4_500_000);
  });
});

describe('modelSupportsVision', () => {
  it('recognises the multimodal families the responder runs', () => {
    expect(modelSupportsVision('anthropic/claude-sonnet-4.6')).toBe(true);
    expect(modelSupportsVision('openai/gpt-4o-mini')).toBe(true);
    expect(modelSupportsVision('google/gemini-2.5-flash')).toBe(true);
    expect(modelSupportsVision('x-ai/grok-4')).toBe(true);
    expect(modelSupportsVision('mistralai/pixtral-12b')).toBe(true);
  });

  it('rejects text-only models and empty input', () => {
    expect(modelSupportsVision('deepseek/deepseek-chat')).toBe(false);
    expect(modelSupportsVision(null)).toBe(false);
    expect(modelSupportsVision(undefined)).toBe(false);
  });
});

/**
 * Context-window source. `parseCatalog` is the pure heart of the live
 * OpenRouter fetch — getting its precedence wrong (model-level vs.
 * provider-level context_length) is exactly how the dashboard's "context %"
 * went 5× stale. The readers are tested against the static fallback only
 * (no network) so they stay deterministic and offline.
 */
describe('parseCatalog', () => {
  it('prefers top_provider.context_length over the model-level value', () => {
    const out = parseCatalog([
      {
        id: 'anthropic/claude-sonnet-4.6',
        context_length: 200_000,
        top_provider: { context_length: 1_000_000 },
      },
    ]);
    expect(out['anthropic/claude-sonnet-4.6']?.contextLength).toBe(1_000_000);
  });

  it('falls back to model-level context_length when top_provider is missing/null', () => {
    const out = parseCatalog([
      { id: 'a/one', context_length: 128_000, top_provider: null },
      { id: 'a/two', context_length: 64_000 },
      { id: 'a/three', context_length: 32_000, top_provider: { context_length: null } },
    ]);
    expect(out['a/one']?.contextLength).toBe(128_000);
    expect(out['a/two']?.contextLength).toBe(64_000);
    expect(out['a/three']?.contextLength).toBe(32_000);
  });

  it('reads vision from architecture.input_modalities (image ⇒ multimodal)', () => {
    const out = parseCatalog([
      {
        id: 'a/sees',
        context_length: 1000,
        architecture: { input_modalities: ['text', 'image', 'file'] },
      },
      { id: 'a/blind', context_length: 1000, architecture: { input_modalities: ['text'] } },
      { id: 'a/nomods', context_length: 1000 },
      { id: 'a/nullmods', context_length: 1000, architecture: { input_modalities: null } },
    ]);
    expect(out['a/sees']?.vision).toBe(true);
    expect(out['a/blind']?.vision).toBe(false);
    expect(out['a/nomods']?.vision).toBe(false);
    expect(out['a/nullmods']?.vision).toBe(false);
  });

  it('lowercases ids so lookups are case-insensitive', () => {
    const out = parseCatalog([
      { id: 'Anthropic/Claude-Opus-4.7', top_provider: { context_length: 1_000_000 } },
    ]);
    expect(out['anthropic/claude-opus-4.7']?.contextLength).toBe(1_000_000);
  });

  it('skips entries with no id or no positive context length', () => {
    const out = parseCatalog([
      { context_length: 100_000 }, // no id
      { id: '', context_length: 100_000 }, // empty id
      { id: 'a/zero', context_length: 0 }, // zero
      { id: 'a/neg', context_length: -1 }, // negative
      { id: 'a/none' }, // no length at all
      { id: 'a/ok', context_length: 50_000 },
    ]);
    expect(Object.keys(out)).toEqual(['a/ok']);
    expect(out['a/ok']?.contextLength).toBe(50_000);
    expect(out['a/ok']?.vision).toBe(false);
  });

  it('extracts pricing as USD per 1M tokens (OpenRouter encodes per-token)', () => {
    const out = parseCatalog([
      {
        id: 'openai/gpt-4o',
        context_length: 128_000,
        // $2.50 / $10 per 1M — encoded as USD per token, string-typed.
        pricing: { prompt: '0.0000025', completion: '0.00001' },
      },
    ]);
    expect(out['openai/gpt-4o']?.inputPricePerM).toBe(2.5);
    expect(out['openai/gpt-4o']?.outputPricePerM).toBe(10);
  });

  it('keeps explicit zero pricing as 0 (free routes)', () => {
    const out = parseCatalog([
      {
        id: 'meta/llama-free',
        context_length: 8_000,
        pricing: { prompt: '0', completion: '0' },
      },
    ]);
    expect(out['meta/llama-free']?.inputPricePerM).toBe(0);
    expect(out['meta/llama-free']?.outputPricePerM).toBe(0);
  });

  it('leaves pricing undefined when the provider omits it', () => {
    const out = parseCatalog([
      // No pricing object at all
      { id: 'a/no-pricing', context_length: 1000 },
      // Empty pricing object
      { id: 'a/empty-pricing', context_length: 1000, pricing: {} },
      // Partial: only prompt
      { id: 'a/half', context_length: 1000, pricing: { prompt: '0.0000025' } },
    ]);
    expect(out['a/no-pricing']?.inputPricePerM).toBeUndefined();
    expect(out['a/no-pricing']?.outputPricePerM).toBeUndefined();
    expect(out['a/empty-pricing']?.inputPricePerM).toBeUndefined();
    expect(out['a/half']?.inputPricePerM).toBe(2.5);
    expect(out['a/half']?.outputPricePerM).toBeUndefined();
  });

  it('treats malformed pricing strings as unknown rather than NaN', () => {
    const out = parseCatalog([
      {
        id: 'a/bad',
        context_length: 1000,
        pricing: { prompt: 'free', completion: '' },
      },
    ]);
    expect(out['a/bad']?.inputPricePerM).toBeUndefined();
    expect(out['a/bad']?.outputPricePerM).toBeUndefined();
  });
});

describe('contextLimitFor / contextSourceFor (static fallback, no live refresh)', () => {
  it('returns the corrected 1M fallback for 4.x sonnet/opus', () => {
    // The bug this whole change fixes: these used to read 200k.
    expect(contextLimitFor('anthropic/claude-sonnet-4.6')).toBe(1_000_000);
    expect(contextLimitFor('anthropic/claude-opus-4.7')).toBe(1_000_000);
    expect(contextLimitFor('anthropic/claude-haiku-4.5')).toBe(200_000);
  });

  it('is case-insensitive on the slug', () => {
    expect(contextLimitFor('Anthropic/Claude-Sonnet-4.6')).toBe(1_000_000);
  });

  it('returns null + unknown for an uncatalogued slug', () => {
    expect(contextLimitFor('totally/not-a-real-model')).toBeNull();
    expect(contextSourceFor('totally/not-a-real-model')).toBe('unknown');
  });

  it('reports fallback provenance before any live fetch', () => {
    expect(contextSourceFor('anthropic/claude-sonnet-4.6')).toBe('fallback');
  });

  it('handles null/undefined slugs gracefully', () => {
    expect(contextLimitFor(null)).toBeNull();
    expect(contextLimitFor(undefined)).toBeNull();
    expect(contextSourceFor(null)).toBe('unknown');
  });
});
