/**
 * deepseek-chat wire-shape lock-down.
 *
 * DeepSeek is OpenAI-compatible at the wire level, so most of the
 * message + tool-call translation is exercised by the openai-compat.ts
 * suite. This file pins the DeepSeek-specific bits:
 *
 *   1. Base URL routing (https://api.deepseek.com/chat/completions)
 *   2. Bearer auth header
 *   3. **The non-standard cache fields** — DeepSeek surfaces cache hits
 *      as TOP-LEVEL `usage.prompt_cache_hit_tokens` (not the OpenAI-
 *      compat `usage.prompt_tokens_details.cached_tokens` shape). The
 *      adapter MUST extract from the DeepSeek-specific field; this
 *      test is the safety net against a future refactor flipping it
 *      back to the compat-shape lookup and silently zeroing cache
 *      tracking.
 *   4. cacheControl is IGNORED (DeepSeek's caching is automatic — no
 *      markers needed, no markers honoured)
 */

import { afterEach, describe, expect, it } from 'vitest';
import { deepseekChatAdapter } from './deepseek-chat';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureFetch(response: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, json: async () => response };
  }) as unknown as typeof fetch;
  return calls;
}

describe('deepseek-chat routing + auth', () => {
  it('POSTs to https://api.deepseek.com/chat/completions with Bearer auth', async () => {
    const calls = captureFetch({
      model: 'deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await deepseekChatAdapter.chat({
      apiKey: 'sk-test-key',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0]!.url).toBe('https://api.deepseek.com/chat/completions');
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test-key');
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('deepseek-chat usage round-trip', () => {
  it('surfaces tokensIn/tokensOut from usage.prompt_tokens / completion_tokens', async () => {
    captureFetch({
      model: 'deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: 'reply' } }],
      usage: { prompt_tokens: 200, completion_tokens: 30 },
    });
    const result = await deepseekChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.tokensIn).toBe(200);
    expect(result.tokensOut).toBe(30);
    expect(result.text).toBe('reply');
  });

  it('extracts cacheReadTokens from DeepSeek-specific prompt_cache_hit_tokens (not the OpenAI-compat shape)', async () => {
    // This test is the safety net for the DeepSeek-specific quirk
    // called out in the catalog + adapter docstrings: cache hits are
    // a TOP-LEVEL usage field, not nested under prompt_tokens_details.
    // If a future refactor incorrectly swaps in the OpenAI-compat
    // shape, this test fails and the trace's cache_read meta silently
    // zeroes out for DeepSeek workers.
    captureFetch({
      model: 'deepseek-v4-pro',
      choices: [{ message: { role: 'assistant', content: 'r' } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
      },
    });
    const result = await deepseekChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.cacheReadTokens).toBe(800);
    // DeepSeek doesn't bill a cache-write line item — should stay undefined.
    expect(result.cacheWriteTokens).toBeUndefined();
  });

  it('does NOT pull cacheReadTokens from prompt_tokens_details.cached_tokens (DeepSeek does not use that shape)', async () => {
    // Defensive: even if a response (perhaps from a future DeepSeek
    // API change) happens to carry prompt_tokens_details, this
    // adapter should still rely on the prompt_cache_hit_tokens field
    // as the authoritative source. Otherwise we'd start double-counting
    // or pulling the wrong number.
    captureFetch({
      model: 'deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: 'r' } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 9999 }, // would be wrong to pick this
        // No prompt_cache_hit_tokens — adapter should treat as 0/undefined
      },
    });
    const result = await deepseekChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.cacheReadTokens).toBeUndefined();
  });

  it('leaves reportedCostUsd undefined (DeepSeek does not return cost)', async () => {
    captureFetch({
      model: 'deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: 'r' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const result = await deepseekChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.reportedCostUsd).toBeUndefined();
    // Trace will fall back to the static price table in
    // packages/tracing/src/pricing.ts (if a deepseek/* entry exists)
    // or record 0 cost otherwise. Both are acceptable per the
    // cookbook's "pricing is best-effort" stance.
  });
});

describe('deepseek-chat cacheControl handling', () => {
  it('ignores opts.cacheControl entirely (DeepSeek caches automatically)', async () => {
    const calls = captureFetch({
      model: 'deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await deepseekChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'you are saskia' },
        { role: 'user', content: 'hi' },
      ],
      cacheControl: { systemPrompt: true, lastUserMessage: true },
    });
    const body = JSON.parse(calls[0]!.init?.body as string);
    // The system message stays a plain string; no cache_control
    // markers should leak into the body. The user message stays string.
    expect(body.messages[0]).toEqual({ role: 'system', content: 'you are saskia' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
    // No cache_control in the body anywhere.
    expect(JSON.stringify(body)).not.toContain('cache_control');
    expect(JSON.stringify(body)).not.toContain('cacheControl');
  });
});

describe('deepseek-chat tool-call passthrough (via openai-compat)', () => {
  it('forwards tools verbatim and extracts OpenAI-shape tool_calls from the response', async () => {
    captureFetch({
      model: 'deepseek-v4-pro',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_ds1',
                type: 'function',
                function: {
                  name: 'note_create',
                  arguments: '{"title":"hi"}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });
    const result = await deepseekChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'make a note' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'note_create',
            description: 'create a note',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    });
    expect(result.toolCalls).toEqual([
      {
        id: 'call_ds1',
        type: 'function',
        function: { name: 'note_create', arguments: '{"title":"hi"}' },
      },
    ]);
  });
});

describe('deepseek-chat error surface', () => {
  it('throws a clear error when apiKey is missing', async () => {
    await expect(
      deepseekChatAdapter.chat({
        apiKey: '',
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/apiKey required/);
  });

  it('throws a clear error when model is missing', async () => {
    await expect(
      deepseekChatAdapter.chat({
        apiKey: 'sk-test',
        model: '',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/model required/);
  });

  it('surfaces non-2xx responses with status code + body excerpt', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"Invalid API key"}}',
    })) as unknown as typeof fetch;
    await expect(
      deepseekChatAdapter.chat({
        apiKey: 'sk-bad',
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/deepseek chat 401/);
  });
});

/**
 * The streaming path has the SAME non-standard cache field to read, and for a
 * long time it did not read it: `chatStream` goes through the shared
 * openai-compat streamer, whose default lookup is
 * `prompt_tokens_details.cached_tokens` — a field DeepSeek never sends. Because
 * the responder streams whenever live-turn streaming is on, that meant the path
 * actually used in production recorded no cache reads at all while the one-shot
 * path recorded them correctly. Pin both halves.
 */
describe('deepseek-chat streaming usage', () => {
  function streamFetch(frames: string[]) {
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const f of frames) controller.enqueue(enc.encode(f));
          controller.close();
        },
      });
      return { ok: true, status: 200, body } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

  it('reads cacheReadTokens from the DeepSeek-specific prompt_cache_hit_tokens', async () => {
    streamFetch([
      sse({ model: 'deepseek-v4-flash', choices: [{ delta: { content: 'ok' } }] }),
      sse({
        choices: [{ finish_reason: 'stop', delta: {} }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 7,
          prompt_cache_hit_tokens: 64,
          prompt_cache_miss_tokens: 36,
        },
      }),
      'data: [DONE]\n\n',
    ]);
    const res = await deepseekChatAdapter.chatStream!(
      {
        apiKey: 'sk-test',
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
      () => {},
    );
    expect(res.cacheReadTokens).toBe(64);
    expect(res.tokensIn).toBe(100);
    expect(res.tokensOut).toBe(7);
  });

  it('still honours the OpenAI-compat spelling if DeepSeek ever sends it', async () => {
    streamFetch([
      sse({
        choices: [{ finish_reason: 'stop', delta: { content: 'ok' } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 8 },
        },
      }),
      'data: [DONE]\n\n',
    ]);
    const res = await deepseekChatAdapter.chatStream!(
      {
        apiKey: 'sk-test',
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
      () => {},
    );
    expect(res.cacheReadTokens).toBe(8);
  });

  it('leaves cacheReadTokens undefined when neither field is present', async () => {
    streamFetch([
      sse({
        choices: [{ finish_reason: 'stop', delta: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
      'data: [DONE]\n\n',
    ]);
    const res = await deepseekChatAdapter.chatStream!(
      {
        apiKey: 'sk-test',
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
      () => {},
    );
    expect(res.cacheReadTokens).toBeUndefined();
  });
});
