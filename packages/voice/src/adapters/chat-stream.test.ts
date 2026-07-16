/**
 * Streaming chat wire-shape lock-down — `chatStream()` across every adapter
 * family we support (Phase 3b + Stop).
 *
 * Three SSE dialects are parsed: OpenAI-compat (`data: {json}` … `[DONE]`, used
 * by xAI/HF/DeepSeek/local via the shared streamer), Anthropic Messages events
 * (`content_block_delta` etc.), and Gemini `:streamGenerateContent?alt=sse`. For
 * each: text deltas reach `onDelta` + accumulate, tool calls assemble, usage
 * round-trips, and a user Stop (an aborted `signal`) returns the PARTIAL reply
 * without throwing. fetch is mocked to stream SSE frames from a ReadableStream.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { xaiChatAdapter } from './xai-chat';
import { anthropicChatAdapter } from './anthropic-chat';
import { googleChatAdapter } from './google-chat';
import type { ChatStreamDelta } from './types';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Mock fetch to stream the given SSE frames (each a full `…\n\n` chunk) from a
 *  ReadableStream body. Returns the captured calls for body/URL assertions. */
function streamFetch(frames: string[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
    return { ok: true, status: 200, body } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

// ─── OpenAI-compat (shared streamer; exercised via xAI) ───────────────────────

describe('OpenAI-compat chatStream (xAI / HF / DeepSeek / local)', () => {
  it('streams text deltas to onDelta + accumulates the reply, with usage', async () => {
    const calls = streamFetch([
      sse({ model: 'grok-4', choices: [{ delta: { content: 'Hel' } }] }),
      sse({ choices: [{ delta: { content: 'lo' } }] }),
      sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
      'data: [DONE]\n\n',
    ]);
    const deltas: ChatStreamDelta[] = [];
    const r = await xaiChatAdapter.chatStream!(
      { apiKey: 'k', model: 'grok-4', messages: [{ role: 'user', content: 'hi' }] },
      (d) => deltas.push(d),
    );
    // Body opts into streaming + a final usage chunk.
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(deltas).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ]);
    expect(r.text).toBe('Hello');
    expect(r.tokensIn).toBe(12);
    expect(r.tokensOut).toBe(3);
  });

  it('assembles tool calls from fragmented tool_call deltas (by index)', async () => {
    streamFetch([
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'note_create', arguments: '{"ti' } },
              ],
            },
          },
        ],
      }),
      sse({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tle":"hi"}' } }] } }],
      }),
      'data: [DONE]\n\n',
    ]);
    const r = await xaiChatAdapter.chatStream!(
      { apiKey: 'k', model: 'grok-4', messages: [{ role: 'user', content: 'note' }] },
      () => {},
    );
    expect(r.toolCalls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'note_create', arguments: '{"title":"hi"}' },
      },
    ]);
  });

  it('forwards a DeepSeek-style reasoning_content channel as reasoning deltas', async () => {
    streamFetch([
      sse({ choices: [{ delta: { reasoning_content: 'thinking…' } }] }),
      sse({ choices: [{ delta: { content: 'answer' } }] }),
      'data: [DONE]\n\n',
    ]);
    const deltas: ChatStreamDelta[] = [];
    const r = await xaiChatAdapter.chatStream!(
      { apiKey: 'k', model: 'grok-4', messages: [{ role: 'user', content: 'hi' }] },
      (d) => deltas.push(d),
    );
    expect(deltas).toContainEqual({ type: 'reasoning', text: 'thinking…' });
    expect(r.text).toBe('answer');
  });

  it('scrubs an inline <think> block from content (split across deltas)', async () => {
    // A local/open reasoning model that inlines its CoT in `content` instead of
    // the reasoning_content channel — the scrubber must keep it out of both the
    // streamed text deltas and the accumulated reply.
    streamFetch([
      sse({ choices: [{ delta: { content: '<think>' } }] }),
      sse({ choices: [{ delta: { content: 'let me reason about this' } }] }),
      sse({ choices: [{ delta: { content: '</think>' } }] }),
      sse({ choices: [{ delta: { content: 'The answer is 42.' } }] }),
      'data: [DONE]\n\n',
    ]);
    const deltas: ChatStreamDelta[] = [];
    const r = await xaiChatAdapter.chatStream!(
      { apiKey: 'k', model: 'grok-4', messages: [{ role: 'user', content: 'hi' }] },
      (d) => deltas.push(d),
    );
    expect(r.text).toBe('The answer is 42.');
    // No reasoning prose leaked into any visible text delta.
    expect(deltas.every((d) => d.type !== 'text' || !d.text.includes('reason'))).toBe(true);
    expect(deltas).toContainEqual({ type: 'text', text: 'The answer is 42.' });
  });

  it('on a user Stop returns the PARTIAL reply (no throw, tool fragments dropped)', async () => {
    const ac = new AbortController();
    streamFetch([
      sse({ choices: [{ delta: { content: 'Partial ' } }] }),
      sse({ choices: [{ delta: { content: 'answer that gets cut' } }] }),
      'data: [DONE]\n\n',
    ]);
    // Abort the moment the first delta lands — the loop breaks before the rest.
    const r = await xaiChatAdapter.chatStream!(
      {
        apiKey: 'k',
        model: 'grok-4',
        messages: [{ role: 'user', content: 'hi' }],
        signal: ac.signal,
      },
      () => ac.abort(),
    );
    expect(r.text).toBe('Partial');
    expect(r.toolCalls).toBeUndefined();
  });

  it('short-circuits to an empty result when already aborted before sending', async () => {
    const ac = new AbortController();
    ac.abort();
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return { ok: true, status: 200, body: new ReadableStream() } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await xaiChatAdapter.chatStream!(
      {
        apiKey: 'k',
        model: 'grok-4',
        messages: [{ role: 'user', content: 'hi' }],
        signal: ac.signal,
      },
      () => {},
    );
    expect(r.text).toBe('');
    expect(fetched).toBe(false);
  });
});

// ─── Anthropic Messages SSE ───────────────────────────────────────────────────

describe('Anthropic chatStream', () => {
  it('parses message_start/content_block_delta/message_delta into text + usage', async () => {
    const calls = streamFetch([
      'event: message_start\n' +
        sse({
          type: 'message_start',
          message: {
            model: 'claude-opus-4-8',
            usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 10 },
          },
        }),
      'event: content_block_start\n' +
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      'event: content_block_delta\n' +
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        }),
      'event: content_block_delta\n' +
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '!' } }),
      'event: message_delta\n' +
        sse({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 15 },
        }),
      'event: message_stop\n' + sse({ type: 'message_stop' }),
    ]);
    const deltas: ChatStreamDelta[] = [];
    const r = await anthropicChatAdapter.chatStream!(
      { apiKey: 'k', model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] },
      (d) => deltas.push(d),
    );
    expect(JSON.parse(calls[0]!.init?.body as string).stream).toBe(true);
    expect(deltas).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: '!' },
    ]);
    expect(r.text).toBe('Hello!');
    expect(r.tokensIn).toBe(25);
    expect(r.tokensOut).toBe(15);
    expect(r.cacheReadTokens).toBe(10);
  });

  it('assembles a tool_use call from content_block_start + input_json_delta fragments', async () => {
    streamFetch([
      'event: message_start\n' +
        sse({
          type: 'message_start',
          message: { model: 'claude-opus-4-8', usage: { input_tokens: 5 } },
        }),
      'event: content_block_start\n' +
        sse({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' },
        }),
      'event: content_block_delta\n' +
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"location":' },
        }),
      'event: content_block_delta\n' +
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"SF"}' },
        }),
      'event: message_delta\n' +
        sse({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 9 },
        }),
    ]);
    const r = await anthropicChatAdapter.chatStream!(
      { apiKey: 'k', model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'weather?' }] },
      () => {},
    );
    expect(r.toolCalls).toEqual([
      {
        id: 'toolu_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"SF"}' },
      },
    ]);
  });

  it('surfaces thinking_delta as reasoning deltas (not visible text)', async () => {
    streamFetch([
      'event: content_block_delta\n' +
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'let me think' },
        }),
      'event: content_block_delta\n' +
        sse({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'answer' },
        }),
    ]);
    const deltas: ChatStreamDelta[] = [];
    const r = await anthropicChatAdapter.chatStream!(
      { apiKey: 'k', model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] },
      (d) => deltas.push(d),
    );
    expect(deltas).toContainEqual({ type: 'reasoning', text: 'let me think' });
    expect(r.text).toBe('answer');
  });

  it('on a user Stop returns the partial text without throwing', async () => {
    const ac = new AbortController();
    streamFetch([
      'event: content_block_delta\n' +
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial' },
        }),
      'event: content_block_delta\n' +
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ' more' },
        }),
    ]);
    const r = await anthropicChatAdapter.chatStream!(
      {
        apiKey: 'k',
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hi' }],
        signal: ac.signal,
      },
      () => ac.abort(),
    );
    expect(r.text).toBe('partial');
  });
});

// ─── Gemini streamGenerateContent (alt=sse) ───────────────────────────────────

describe('Google chatStream', () => {
  it('hits :streamGenerateContent?alt=sse and accumulates text parts + usage', async () => {
    const calls = streamFetch([
      sse({
        candidates: [{ content: { parts: [{ text: 'Ocean ' }] } }],
        modelVersion: 'gemini-3-flash',
      }),
      sse({ candidates: [{ content: { parts: [{ text: 'currents' }] } }] }),
      sse({
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, cachedContentTokenCount: 2 },
      }),
    ]);
    const deltas: ChatStreamDelta[] = [];
    const r = await googleChatAdapter.chatStream!(
      { apiKey: 'k', model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hi' }] },
      (d) => deltas.push(d),
    );
    expect(calls[0]!.url).toContain(':streamGenerateContent?alt=sse');
    expect(deltas).toEqual([
      { type: 'text', text: 'Ocean ' },
      { type: 'text', text: 'currents' },
    ]);
    expect(r.text).toBe('Ocean currents');
    expect(r.tokensIn).toBe(8);
    expect(r.tokensOut).toBe(4);
    expect(r.cacheReadTokens).toBe(2);
  });

  it('collects whole functionCall parts into tool calls', async () => {
    streamFetch([
      sse({
        candidates: [
          { content: { parts: [{ functionCall: { name: 'get_time', args: { tz: 'UTC' } } }] } },
        ],
      }),
      sse({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }),
    ]);
    const r = await googleChatAdapter.chatStream!(
      { apiKey: 'k', model: 'gemini-3-flash', messages: [{ role: 'user', content: 'time?' }] },
      () => {},
    );
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]!.function).toEqual({ name: 'get_time', arguments: '{"tz":"UTC"}' });
  });

  it('on a user Stop returns the partial text without throwing', async () => {
    const ac = new AbortController();
    streamFetch([
      sse({ candidates: [{ content: { parts: [{ text: 'half' }] } }] }),
      sse({ candidates: [{ content: { parts: [{ text: ' answer' }] } }] }),
    ]);
    const r = await googleChatAdapter.chatStream!(
      {
        apiKey: 'k',
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        signal: ac.signal,
      },
      () => ac.abort(),
    );
    expect(r.text).toBe('half');
  });
});
