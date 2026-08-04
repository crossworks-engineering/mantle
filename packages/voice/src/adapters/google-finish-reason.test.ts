/**
 * `finishReason` lock-down for google-chat (one-shot + streaming).
 *
 * Why this matters: Gemini returns HTTP 200 with an empty or short reply in
 * three very different situations — the model finished, the model was cut off
 * at maxOutputTokens, or the provider withheld the content on a safety rule.
 * Before `ChatResult.finishReason` existed we discarded `candidates[0].
 * finishReason` entirely, so all three arrived at the responder as an
 * indistinguishable successful call. These tests pin the mapping so a
 * truncated or blocked reply stays identifiable.
 *
 * The mapping is deliberately lossy: every withheld-content flavour Gemini can
 * report collapses to 'content_filter', because callers act identically on all
 * of them.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { googleChatAdapter } from './google-chat';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Mock a one-shot `:generateContent` reply. */
function jsonFetch(response: unknown) {
  globalThis.fetch = (async () => ({ ok: true, json: async () => response })) as unknown as typeof fetch;
}

/** Mock a `:streamGenerateContent?alt=sse` body from SSE frames. */
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

const BASE = {
  apiKey: 'gk-test',
  model: 'gemini-2.5-flash',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('google-chat finishReason (one-shot)', () => {
  it('maps STOP without tool calls to stop', async () => {
    jsonFetch({
      candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
      usageMetadata: {},
    });
    const r = await googleChatAdapter.chat(BASE);
    expect(r.finishReason).toBe('stop');
  });

  // STOP is context-sensitive: with functionCall parts present it means the
  // model paused to call tools, not that it finished answering.
  it('maps STOP with tool calls to tool_calls', async () => {
    jsonFetch({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: 'get_time', args: {} } }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {},
    });
    const r = await googleChatAdapter.chat(BASE);
    expect(r.finishReason).toBe('tool_calls');
    expect(r.toolCalls).toHaveLength(1);
  });

  it('maps MAX_TOKENS to length so callers know the reply is truncated', async () => {
    jsonFetch({
      candidates: [{ content: { parts: [{ text: 'half an ans' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: {},
    });
    const r = await googleChatAdapter.chat(BASE);
    expect(r.finishReason).toBe('length');
  });

  // The regression this whole field exists for: a blocked reply is an empty
  // 200. Without finishReason it is indistinguishable from a terse answer.
  it.each(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'])(
    'maps %s to content_filter',
    async (reason) => {
      jsonFetch({
        candidates: [{ content: { parts: [] }, finishReason: reason }],
        usageMetadata: {},
      });
      const r = await googleChatAdapter.chat(BASE);
      expect(r.text).toBe('');
      expect(r.finishReason).toBe('content_filter');
    },
  );

  it('maps MALFORMED_FUNCTION_CALL to error', async () => {
    jsonFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }],
      usageMetadata: {},
    });
    const r = await googleChatAdapter.chat(BASE);
    expect(r.finishReason).toBe('error');
  });

  it('maps an unknown reason to other rather than guessing', async () => {
    jsonFetch({
      candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'SOMETHING_NEW' }],
      usageMetadata: {},
    });
    const r = await googleChatAdapter.chat(BASE);
    expect(r.finishReason).toBe('other');
  });

  // Absent must stay absent: asserting 'stop' would claim a clean finish we
  // were never told about.
  it('leaves finishReason undefined when Gemini reports none', async () => {
    jsonFetch({
      candidates: [{ content: { parts: [{ text: 'x' }] } }],
      usageMetadata: {},
    });
    const r = await googleChatAdapter.chat(BASE);
    expect(r.finishReason).toBeUndefined();
  });
});

describe('google-chat finishReason (streaming)', () => {
  it('picks up a finishReason arriving on the final chunk', async () => {
    streamFetch([
      sse({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }),
      sse({
        candidates: [{ finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      }),
    ]);
    const r = await googleChatAdapter.chatStream!(BASE, () => {});
    expect(r.text).toBe('partial');
    expect(r.finishReason).toBe('length');
  });

  it('reports content_filter on a stream that is cut off by a safety block', async () => {
    streamFetch([sse({ candidates: [{ finishReason: 'SAFETY' }] })]);
    const r = await googleChatAdapter.chatStream!(BASE, () => {});
    expect(r.text).toBe('');
    expect(r.finishReason).toBe('content_filter');
  });

  it('maps STOP to tool_calls when the stream carried a functionCall', async () => {
    streamFetch([
      sse({
        candidates: [
          { content: { parts: [{ functionCall: { name: 'get_time', args: { tz: 'UTC' } } }] } },
        ],
      }),
      sse({ candidates: [{ finishReason: 'STOP' }] }),
    ]);
    const r = await googleChatAdapter.chatStream!(BASE, () => {});
    expect(r.finishReason).toBe('tool_calls');
  });
});
