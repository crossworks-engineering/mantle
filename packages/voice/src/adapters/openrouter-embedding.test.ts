/**
 * Wire-shape lock-down for the OpenRouter embedding adapter's dimension
 * handling. The brain's vector columns are 768-wide, so an adapter that lets
 * a native-3072 model through breaks every insert — these tests pin:
 *   1. `dimensions` is sent upstream for OpenAI's MRL family,
 *   2. an oversized response is truncated + renormalised client-side
 *      (OR doesn't forward `dimensions` to every upstream),
 *   3. non-MRL models are never truncated (it would corrupt them).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { openrouterEmbedding } from './openrouter-embedding';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureFetch(response: unknown) {
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return { ok: true, status: 200, json: async () => response };
  }) as unknown as typeof fetch;
  return calls;
}

const embedResponse = (vec: number[]) => ({
  data: [{ embedding: vec, index: 0 }],
  model: 'openai/text-embedding-3-large',
  usage: { prompt_tokens: 2 },
});

describe('openrouter-embedding dimensions', () => {
  it('sends the OpenAI `dimensions` param for the text-embedding-3-* family', async () => {
    const calls = captureFetch(embedResponse(new Array(768).fill(0.5)));
    await openrouterEmbedding.embed({
      apiKey: 'k',
      model: 'openai/text-embedding-3-large',
      input: ['hello'],
      dimensions: 768,
    });
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body.dimensions).toBe(768);
    expect(body.output_dimensionality).toBeUndefined();
  });

  it('truncates + renormalises an oversized MRL vector to the requested dims', async () => {
    // Upstream ignored `dimensions` and returned native 3072.
    captureFetch(embedResponse(new Array(3072).fill(1)));
    const res = await openrouterEmbedding.embed({
      apiKey: 'k',
      model: 'openai/text-embedding-3-large',
      input: ['hello'],
      dimensions: 768,
    });
    const vec = res.vectors[0]!;
    expect(vec).toHaveLength(768);
    // L2 norm ≈ 1 after renormalisation.
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('returns already-correct vectors untouched', async () => {
    captureFetch(embedResponse([3, 4]));
    const res = await openrouterEmbedding.embed({
      apiKey: 'k',
      model: 'openai/text-embedding-3-large',
      input: ['hello'],
      dimensions: 2,
    });
    // Length matches the request → no truncation, no renormalisation.
    expect(res.vectors[0]).toEqual([3, 4]);
  });

  it('never truncates a non-MRL model', async () => {
    const big = new Array(1024).fill(0.25);
    const calls = captureFetch({ data: [{ embedding: big, index: 0 }], model: 'mistralai/mistral-embed' });
    const res = await openrouterEmbedding.embed({
      apiKey: 'k',
      model: 'mistralai/mistral-embed',
      input: ['hello'],
      dimensions: 768,
    });
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body.dimensions).toBeUndefined();
    expect(res.vectors[0]).toHaveLength(1024);
  });

  it('keeps output_dimensionality for the multimodal family', async () => {
    const calls = captureFetch({ data: [{ embedding: new Array(768).fill(0.1), index: 0 }] });
    await openrouterEmbedding.embed({
      apiKey: 'k',
      model: 'google/gemini-embedding-2-preview',
      input: ['hello'],
      dimensions: 768,
    });
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body.output_dimensionality).toBe(768);
    expect(body.dimensions).toBeUndefined();
  });
});
