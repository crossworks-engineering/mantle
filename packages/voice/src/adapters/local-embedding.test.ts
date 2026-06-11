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

  it('sub-batches large inputs into multiple sequential requests, order preserved', async () => {
    // The prod regression this pins: one giant request (caller batches up to
    // 100) exceeded the timeout on a CPU-only server. 20 inputs with
    // SUB_BATCH=16 must become 2 requests (16 + 4), vectors reassembled in
    // input order and token usage summed.
    const calls: Array<{ input: string[] }> = [];
    let offset = 0;
    globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { input: string[] };
      calls.push({ input: body.input });
      const base = offset;
      offset += body.input.length;
      return {
        ok: true,
        json: async () => ({
          data: body.input.map((_, i) => ({ embedding: [base + i], index: i })),
          model: 'm',
          usage: { prompt_tokens: body.input.length },
        }),
      };
    }) as unknown as typeof fetch;

    const a = getEmbeddingAdapter('local')!;
    const texts = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const r = await a.embed({ apiKey: 'x', model: 'm', input: texts });

    expect(calls.length).toBe(2);
    expect(calls[0]!.input.length).toBe(16);
    expect(calls[1]!.input.length).toBe(4);
    expect(r.vectors.length).toBe(20);
    // Order: vector i carries the global offset i.
    expect(r.vectors.map((v) => v[0])).toEqual(texts.map((_, i) => i));
    expect(r.tokensIn).toBe(20);
  });
});
