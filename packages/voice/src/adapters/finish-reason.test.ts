/**
 * `finishReason` lock-down for the non-Google chat adapters.
 *
 * Three stop-reason vocabularies reach `ChatResult.finishReason`:
 *   - Anthropic's `stop_reason` (end_turn / max_tokens / tool_use / refusal …)
 *   - the OpenAI-compat `finish_reason`, shared by xAI, HuggingFace, DeepSeek,
 *     local, Copilot and custom through `mapOpenAICompatFinishReason`
 *   - OpenRouter's, which is the OpenAI vocabulary plus `error`
 *
 * Google's mapping lives in google-finish-reason.test.ts; it needs its own file
 * because Gemini's `STOP` is ambiguous and has to be disambiguated by whether
 * tool calls are present.
 *
 * The invariant every case here defends: a truncated or withheld reply must be
 * distinguishable from a short one. All three arrive as HTTP 200.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { anthropicChatAdapter } from './anthropic-chat';
import { xaiChatAdapter } from './xai-chat';
import { mapOpenAICompatFinishReason } from './openai-compat';
import type { ChatFinishReason } from './types';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonFetch(response: unknown) {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => response,
  })) as unknown as typeof fetch;
}

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
const MSG = [{ role: 'user' as const, content: 'hi' }];

// ─── the shared OpenAI-compat mapper ────────────────────────────────────────

describe('mapOpenAICompatFinishReason', () => {
  it.each<[string, ChatFinishReason]>([
    ['stop', 'stop'],
    ['length', 'length'],
    // Non-standard spelling seen on some self-hosted servers.
    ['max_tokens', 'length'],
    ['tool_calls', 'tool_calls'],
    // Pre-2023 spelling, still emitted by older local builds.
    ['function_call', 'tool_calls'],
    ['content_filter', 'content_filter'],
    // OpenRouter-only: an upstream provider failed mid-generation.
    ['error', 'error'],
    ['something_new', 'other'],
  ])('maps %s to %s', (raw, expected) => {
    expect(mapOpenAICompatFinishReason(raw)).toBe(expected);
  });

  // Many OpenAI-compatible servers, especially local runtimes, omit the field.
  // Undefined must mean "not reported", never "finished cleanly".
  it.each([undefined, null, ''])(
    'returns undefined for %p rather than defaulting to stop',
    (raw) => {
      expect(mapOpenAICompatFinishReason(raw)).toBeUndefined();
    },
  );
});

// ─── Anthropic ──────────────────────────────────────────────────────────────

describe('anthropic-chat finishReason', () => {
  const anthropicBody = (stopReason?: string) => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: [{ type: 'text', text: 'hello' }],
    ...(stopReason ? { stop_reason: stopReason } : {}),
    usage: { input_tokens: 3, output_tokens: 2 },
  });

  it.each<[string, ChatFinishReason]>([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['model_context_window_exceeded', 'length'],
    ['tool_use', 'tool_calls'],
    // A policy refusal: the reply was withheld, so callers treat it the same
    // way they treat a Gemini safety block.
    ['refusal', 'content_filter'],
    // A server-tool pause is neither a completion nor a failure.
    ['pause_turn', 'other'],
  ])('maps stop_reason %s to %s', async (raw, expected) => {
    jsonFetch(anthropicBody(raw));
    const r = await anthropicChatAdapter.chat({
      apiKey: 'k',
      model: 'claude-opus-4-8',
      messages: MSG,
    });
    expect(r.finishReason).toBe(expected);
  });

  it('leaves finishReason undefined when no stop_reason is reported', async () => {
    jsonFetch(anthropicBody());
    const r = await anthropicChatAdapter.chat({
      apiKey: 'k',
      model: 'claude-opus-4-8',
      messages: MSG,
    });
    expect(r.finishReason).toBeUndefined();
  });

  // stop_reason rides `message_delta`, the same event that carries cumulative
  // output tokens. It must be read even when that event has no usage payload.
  it('picks up stop_reason from a message_delta carrying no usage', async () => {
    streamFetch([
      'event: content_block_delta\n' +
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cut' } }),
      'event: message_delta\n' +
        sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
      'event: message_stop\n' + sse({ type: 'message_stop' }),
    ]);
    const r = await anthropicChatAdapter.chatStream!(
      { apiKey: 'k', model: 'claude-opus-4-8', messages: MSG },
      () => {},
    );
    expect(r.text).toBe('cut');
    expect(r.finishReason).toBe('length');
  });

  it('reports both usage and stop_reason when message_delta carries both', async () => {
    streamFetch([
      'event: content_block_delta\n' +
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      'event: message_delta\n' +
        sse({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 9 },
        }),
    ]);
    const r = await anthropicChatAdapter.chatStream!(
      { apiKey: 'k', model: 'claude-opus-4-8', messages: MSG },
      () => {},
    );
    expect(r.tokensOut).toBe(9);
    expect(r.finishReason).toBe('stop');
  });
});

// ─── OpenAI-compat family (xAI stands in for all six) ───────────────────────

describe('openai-compat finishReason', () => {
  it('surfaces finish_reason from a one-shot response', async () => {
    jsonFetch({
      model: 'grok-4.3',
      choices: [{ message: { role: 'assistant', content: 'truncated' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    });
    const r = await xaiChatAdapter.chat({ apiKey: 'k', model: 'grok-4.3', messages: MSG });
    expect(r.finishReason).toBe('length');
  });

  it('leaves finishReason undefined when the server omits finish_reason', async () => {
    jsonFetch({
      model: 'grok-4.3',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: {},
    });
    const r = await xaiChatAdapter.chat({ apiKey: 'k', model: 'grok-4.3', messages: MSG });
    expect(r.finishReason).toBeUndefined();
  });

  // The regression guard for the shared streamer: the terminal chunk carries
  // finish_reason and NO delta, so reading it after the `!delta` bail would
  // drop it silently on every streamed call.
  it('reads finish_reason off a terminal chunk that carries no delta', async () => {
    streamFetch([
      sse({ model: 'grok-4.3', choices: [{ delta: { content: 'half' } }] }),
      // No `delta` key at all on the chunk that reports the reason. Deliberate:
      // if any frame here also carried a delta it would mask a regression where
      // the read happens after the `!delta` bail.
      sse({
        choices: [{ finish_reason: 'length' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
      'data: [DONE]\n\n',
    ]);
    const r = await xaiChatAdapter.chatStream!(
      { apiKey: 'k', model: 'grok-4.3', messages: MSG },
      () => {},
    );
    expect(r.text).toBe('half');
    expect(r.finishReason).toBe('length');
  });

  it('maps a streamed content_filter stop', async () => {
    streamFetch([
      sse({ model: 'grok-4.3', choices: [{ finish_reason: 'content_filter' }] }),
      'data: [DONE]\n\n',
    ]);
    const r = await xaiChatAdapter.chatStream!(
      { apiKey: 'k', model: 'grok-4.3', messages: MSG },
      () => {},
    );
    expect(r.text).toBe('');
    expect(r.finishReason).toBe('content_filter');
  });
});

// ─── Anthropic sampling-param guard ─────────────────────────────────────────
//
// Brought over from the @ai-sdk/anthropic comparison: rejecting temperature /
// top_p is a property of the MODEL, not of whether thinking was requested this
// round. The body builder previously dropped them only while thinking was on,
// so a tool continuation (where wantGuardedThinking suppresses thinking) put
// temperature back on the wire for models that never accept it.

describe('anthropic-chat sampling params', () => {
  const body = () => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'x',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  function captureBody() {
    const calls: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls.push(String(init?.body ?? ''));
      return { ok: true, json: async () => body() };
    }) as unknown as typeof fetch;
    return calls;
  }

  // The regression case: no thinking requested (as on every tool-continuation
  // round), temperature set, model rejects it.
  it.each(['claude-opus-4-7', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5'])(
    'omits temperature/top_p for %s even with thinking off',
    async (model) => {
      const calls = captureBody();
      await anthropicChatAdapter.chat({
        apiKey: 'k',
        model,
        messages: MSG,
        temperature: 0.7,
        topP: 0.9,
      });
      const sent = JSON.parse(calls[0]!);
      expect(sent.temperature).toBeUndefined();
      expect(sent.top_p).toBeUndefined();
      expect(sent.thinking).toBeUndefined();
    },
  );

  // Dated snapshots must resolve the same way as the bare id.
  it('matches on prefix so dated snapshots are covered', async () => {
    const calls = captureBody();
    await anthropicChatAdapter.chat({
      apiKey: 'k',
      model: 'claude-opus-4-7-20260315',
      messages: MSG,
      temperature: 0.7,
    });
    expect(JSON.parse(calls[0]!).temperature).toBeUndefined();
  });

  // Contrast: a model that DOES accept them still gets them, so the guard is
  // specific rather than a blanket drop.
  it('still sends temperature/top_p for a model that accepts them', async () => {
    const calls = captureBody();
    await anthropicChatAdapter.chat({
      apiKey: 'k',
      model: 'claude-sonnet-4-6',
      messages: MSG,
      temperature: 0.7,
      topP: 0.9,
    });
    const sent = JSON.parse(calls[0]!);
    expect(sent.temperature).toBe(0.7);
    expect(sent.top_p).toBe(0.9);
  });
});
