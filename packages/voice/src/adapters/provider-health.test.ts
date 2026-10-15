import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerHealth, sameLocalModel } from './provider-health';

afterEach(() => {
  vi.unstubAllGlobals();
});

function serve(res: Response | Error): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

describe('providerHealth (the one local model probe)', () => {
  it('asks <base>/models once, trailing slashes ignored', async () => {
    const stub = serve(new Response(JSON.stringify({ data: [] })));
    await providerHealth('http://ollama:11434/v1//', { timeoutMs: 1_500 });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0]![0]).toBe('http://ollama:11434/v1/models');
  });

  it('reports the model loaded with :latest tolerated either side', async () => {
    serve(new Response(JSON.stringify({ data: [{ id: 'embeddinggemma:latest' }, { id: 7 }] })));
    expect(
      await providerHealth('http://h/v1', { timeoutMs: 1_500, model: 'embeddinggemma' }),
    ).toEqual({ up: true, ids: ['embeddinggemma:latest'], loaded: true });
    expect(sameLocalModel('a', 'a:latest')).toBe(true);
    expect(sameLocalModel('a:7b', 'a')).toBe(false);
  });

  it('says not loaded, no model asked, or an unreadable list', async () => {
    serve(new Response(JSON.stringify({ data: [{ id: 'other' }] })));
    expect((await providerHealth('http://h', { timeoutMs: 1, model: 'm' })).up).toBe(true);
    serve(new Response(JSON.stringify({ data: [{ id: 'other' }] })));
    expect(await providerHealth('http://h', { timeoutMs: 1, model: 'm' })).toMatchObject({
      loaded: false,
    });
    serve(new Response(JSON.stringify({ data: [] })));
    expect(await providerHealth('http://h', { timeoutMs: 1 })).toMatchObject({ loaded: null });
    serve(new Response('not json'));
    expect(await providerHealth('http://h', { timeoutMs: 1, model: 'm' })).toEqual({
      up: true,
      ids: null,
      loaded: null,
    });
  });

  it('separates an error status from no answer, and never throws', async () => {
    serve(new Response('down', { status: 503 }));
    expect(await providerHealth('http://h', { timeoutMs: 1 })).toEqual({
      up: false,
      reason: 'http',
      status: 503,
    });
    serve(new TypeError('fetch failed'));
    expect(await providerHealth('http://h', { timeoutMs: 1 })).toEqual({
      up: false,
      reason: 'unreachable',
    });
  });
});
