/**
 * custom-chat wire-shape lock-down.
 *
 * The custom provider is OpenAI-compatible at the chat layer (translation +
 * streaming are covered by the openai-compat suite), so this file pins the
 * custom-specific contract:
 *   1. Base URL is REQUIRED, taken per-route from opts.baseUrl, and
 *      `/chat/completions` is appended (trailing slashes trimmed).
 *   2. The route's API key rides as a Bearer; key is REQUIRED.
 *   3. `reasoning_effort` is sent from thinkingBudget, sampling params dropped
 *      when reasoning is on (consistent with Copilot).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { customChatAdapter } from './custom-chat';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureFetch(reply: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => reply };
  }) as unknown as typeof fetch;
  return calls;
}

const reply = (over?: Record<string, unknown>) => ({
  model: 'glm-4.6',
  choices: [{ message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 5, completion_tokens: 2 },
  ...over,
});

describe('custom-chat base URL + auth', () => {
  it('POSTs to the per-route base URL with the Bearer key', async () => {
    const calls = captureFetch(reply());
    await customChatAdapter.chat({
      apiKey: 'sk-custom-1',
      model: 'glm-4.6',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0]!.url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    const h = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(h.Authorization).toBe('Bearer sk-custom-1');
  });

  it('trims a trailing slash on the base URL', async () => {
    const calls = captureFetch(reply());
    await customChatAdapter.chat({
      apiKey: 'sk-custom-1',
      model: 'glm-4.6',
      baseUrl: 'https://api.z.ai/api/paas/v4/',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0]!.url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
  });

  it('throws a clear error when baseUrl is missing', async () => {
    await expect(
      customChatAdapter.chat({
        apiKey: 'sk',
        model: 'glm-4.6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/baseUrl required/);
  });

  it('throws when the API key is missing (custom is the keyed cloud path)', async () => {
    await expect(
      customChatAdapter.chat({
        apiKey: '',
        model: 'glm-4.6',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/apiKey required/);
  });

  it('throws when the model is missing', async () => {
    await expect(
      customChatAdapter.chat({
        apiKey: 'sk',
        model: '',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/model required/);
  });
});

describe('custom-chat reasoning', () => {
  it('sends reasoning_effort from thinkingBudget and drops sampling params', async () => {
    const calls = captureFetch(reply());
    await customChatAdapter.chat({
      apiKey: 'sk',
      model: 'glm-4.6',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      messages: [{ role: 'user', content: 'hi' }],
      thinkingBudget: 5000, // → 'medium'
      temperature: 0.7,
      topP: 0.9,
    });
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.reasoning_effort).toBe('medium');
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it('omits reasoning_effort when no budget is set (and keeps sampling params)', async () => {
    const calls = captureFetch(reply());
    await customChatAdapter.chat({
      apiKey: 'sk',
      model: 'glm-4.6',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
    });
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.temperature).toBe(0.5);
  });
});

describe('custom-chat result mapping', () => {
  it('returns text + usage and surfaces the cache-read signal', async () => {
    captureFetch(
      reply({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 7 },
        },
      }),
    );
    const r = await customChatAdapter.chat({
      apiKey: 'sk',
      model: 'glm-4.6',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.text).toBe('ok');
    expect(r.tokensIn).toBe(10);
    expect(r.tokensOut).toBe(3);
    expect(r.cacheReadTokens).toBe(7);
  });
});
