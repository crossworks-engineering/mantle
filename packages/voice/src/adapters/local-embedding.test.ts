import { afterEach, describe, expect, it } from 'vitest';
import { getEmbeddingAdapter } from './registry';
import './index'; // side-effect: register built-in adapters

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.MANTLE_LOCAL_EMBEDDING_URL;
});

type Call = { url: string; body: unknown };
function mockEmbed(vec: number[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: unknown, init: { body?: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
    return {
      ok: true,
      json: async () => ({ data: [{ embedding: vec, index: 0 }], model: 'm', usage: { prompt_tokens: 3 } }),
    };
  }) as unknown as typeof fetch;
  return calls;
}

describe('local-embedding adapter', () => {
  it('registers under provider id "local"', () => {
    const a = getEmbeddingAdapter('local');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('local-embedding');
  });

  it('POSTs to the configured base URL /embeddings with model + input', async () => {
    process.env.MANTLE_LOCAL_EMBEDDING_URL = 'http://box:1234/v1';
    const calls = mockEmbed([0.1, 0.2, 0.3]);
    const a = getEmbeddingAdapter('local')!;
    const r = await a.embed({ apiKey: 'x', model: 'embeddinggemma', input: ['hi'] });
    expect(calls[0]!.url).toBe('http://box:1234/v1/embeddings');
    expect(calls[0]!.body).toMatchObject({ model: 'embeddinggemma', input: ['hi'] });
    expect(r.vectors[0]).toEqual([0.1, 0.2, 0.3]);
    expect(r.tokensIn).toBe(3);
  });

  it('defaults to Ollama localhost:11434 when no env is set', async () => {
    const calls = mockEmbed([0]);
    const a = getEmbeddingAdapter('local')!;
    await a.embed({ apiKey: 'x', model: 'm', input: ['hi'] });
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/embeddings');
  });

  it('rejects non-text input (text-only)', async () => {
    const a = getEmbeddingAdapter('local')!;
    await expect(
      a.embed({ apiKey: 'x', model: 'm', input: [{ type: 'image', url: 'x' }] }),
    ).rejects.toThrow(/text-only/);
  });
});
