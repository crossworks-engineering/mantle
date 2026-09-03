import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChatAdapter } from './registry';
import { localChatAdapter } from './local-chat';
import './index'; // side-effect: register built-in adapters

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.MANTLE_LOCAL_CHAT_URL;
});

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
function mockChat(content: string): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (
    url: unknown,
    init: { body?: string; headers?: Record<string, string> },
  ) => {
    calls.push({
      url: String(url),
      body: JSON.parse(init?.body ?? '{}'),
      headers: init?.headers ?? {},
    });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content } }],
        model: 'gemma-3-12b',
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    };
  }) as unknown as typeof fetch;
  return calls;
}

describe('local-chat adapter', () => {
  it('registers under provider id "local" (chat)', () => {
    const a = getChatAdapter('local');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('local-chat');
  });

  it('POSTs OpenAI-compat /chat/completions to the per-route baseUrl, keyless', async () => {
    const calls = mockChat('summarised.');
    const r = await localChatAdapter.chat({
      apiKey: '',
      model: 'gemma-3-12b',
      baseUrl: 'http://gpu-box:1234/v1',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'summarise' },
      ],
    });
    expect(calls[0]!.url).toBe('http://gpu-box:1234/v1/chat/completions');
    expect(calls[0]!.body).toMatchObject({ model: 'gemma-3-12b' });
    expect(calls[0]!.headers.Authorization).toBe('Bearer local'); // keyless placeholder
    expect(r.text).toBe('summarised.');
    expect(r.model).toBe('gemma-3-12b');
    expect(r.tokensIn).toBe(11);
    expect(r.tokensOut).toBe(7);
  });

  it('falls back baseUrl → env → Ollama localhost:11434', async () => {
    const calls = mockChat('x');
    process.env.MANTLE_LOCAL_CHAT_URL = 'http://lan-box:11434/v1';
    await localChatAdapter.chat({
      apiKey: '',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0]!.url).toBe('http://lan-box:11434/v1/chat/completions');

    delete process.env.MANTLE_LOCAL_CHAT_URL;
    const calls2 = mockChat('x');
    await localChatAdapter.chat({
      apiKey: '',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls2[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('does not send the tools field when none are provided', async () => {
    const calls = mockChat('x');
    await localChatAdapter.chat({
      apiKey: '',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0]!.body.tools).toBeUndefined();
  });

  it('gives the STREAMING path the same 300s connect budget as the one-shot path', async () => {
    // The shared stream default is 60s, which suits a hosted provider. A local
    // server loading a cold model into VRAM takes longer, and a connect timeout
    // is classified RETRYABLE — so the default re-sent the whole prompt twice
    // and then failed the turn on a box that was simply still warming up.
    vi.useFakeTimers();
    let captured: AbortSignal | undefined;
    globalThis.fetch = ((_u: unknown, init: { signal?: AbortSignal }) => {
      captured = init?.signal;
      return new Promise<never>(() => {}); // never settles; we assert on the signal
    }) as unknown as typeof fetch;

    void localChatAdapter.chatStream!(
      { apiKey: '', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    ).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(captured).toBeDefined();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(captured!.aborted, 'the 60s default must not govern the local route').toBe(false);

    await vi.advanceTimersByTimeAsync(240_000);
    expect(captured!.aborted, 'but 300s still bounds it — no unbounded hang').toBe(true);
    vi.useRealTimers();
  });
});
