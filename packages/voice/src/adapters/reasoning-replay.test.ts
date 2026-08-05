/**
 * Signed-reasoning replay across tool rounds — Anthropic direct + Gemini.
 *
 * The problem this closes: both providers sign their reasoning and require the
 * signature back on any continued turn. Our tool loop used to rebuild the
 * assistant turn from text + toolCalls only, dropping the signature, so
 * `wantGuardedThinking` switched thinking OFF for the rest of every tool loop.
 * The model reasoned on round one and then composed the answer the user
 * actually reads with reasoning disabled.
 *
 * Both halves are tested here because either one alone is useless: capturing a
 * signature nobody replays changes nothing, and replaying one we never captured
 * sends garbage. The round-trip tests below feed a captured response straight
 * back in as history and assert on the emitted wire body.
 *
 * Fidelity is the thing to protect. Anthropic validates the signature against
 * the EXACT thinking text, so any trimming, re-joining or reordering breaks the
 * next request — and it breaks it as an HTTP 400 mid-turn, not at build time.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { anthropicChatAdapter } from './anthropic-chat';
import { googleChatAdapter } from './google-chat';
import { canReplayReasoning, wantGuardedThinking } from './thinking-guard';
import type { ChatToolLoopMessage } from './types';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureFetch(response: unknown) {
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return { ok: true, json: async () => response };
  }) as unknown as typeof fetch;
  return calls;
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
const USER = [{ role: 'user' as const, content: 'what time is it?' }];

// ─── Anthropic ──────────────────────────────────────────────────────────────

describe('anthropic-chat signed reasoning', () => {
  const THINKING = 'Let me check the clock tool for this.';
  const SIG = 'ErUBCkYIBRgCIkC0signature-bytes';

  const responseWithThinking = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: [
      { type: 'thinking', thinking: THINKING, signature: SIG },
      { type: 'tool_use', id: 'toolu_1', name: 'get_time', input: { tz: 'UTC' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  it('captures thinking blocks as signed reasoning details', async () => {
    captureFetch(responseWithThinking);
    const r = await anthropicChatAdapter.chat({
      apiKey: 'k',
      model: 'claude-opus-4-8',
      messages: USER,
      thinkingBudget: 2048,
    });
    expect(r.reasoningDetails).toEqual([
      { type: 'reasoning.text', index: 0, text: THINKING, signature: SIG },
    ]);
  });

  it('captures redacted thinking as an encrypted detail', async () => {
    captureFetch({
      ...responseWithThinking,
      content: [{ type: 'redacted_thinking', data: 'opaque-payload' }],
    });
    const r = await anthropicChatAdapter.chat({
      apiKey: 'k',
      model: 'claude-opus-4-8',
      messages: USER,
    });
    expect(r.reasoningDetails).toEqual([
      { type: 'reasoning.encrypted', index: 0, data: 'opaque-payload' },
    ]);
  });

  // An unsigned thinking block cannot be replayed (the API rejects it), so
  // keeping it would poison the NEXT request rather than the current one.
  it('drops a thinking block that arrived without a signature', async () => {
    captureFetch({
      ...responseWithThinking,
      content: [{ type: 'thinking', thinking: 'unsigned' }],
    });
    const r = await anthropicChatAdapter.chat({
      apiKey: 'k',
      model: 'claude-opus-4-8',
      messages: USER,
    });
    expect(r.reasoningDetails).toBeUndefined();
  });

  // The actual round trip: capture, then feed it back as history.
  it('replays the block, byte-identical, ahead of the tool_use block', async () => {
    captureFetch(responseWithThinking);
    const first = await anthropicChatAdapter.chat({
      apiKey: 'k',
      model: 'claude-opus-4-8',
      messages: USER,
      thinkingBudget: 2048,
    });

    const calls = captureFetch(responseWithThinking);
    await anthropicChatAdapter.chat({
      apiKey: 'k',
      model: 'claude-opus-4-8',
      thinkingBudget: 2048,
      messages: [
        ...USER,
        {
          role: 'assistant',
          content: null,
          toolCalls: first.toolCalls!,
          reasoningDetails: first.reasoningDetails,
        },
        { role: 'tool', toolCallId: first.toolCalls![0]!.id, content: '12:00' },
      ],
    });

    const sent = JSON.parse(calls[0]!.body);
    const assistant = sent.messages.find((m: { role: string }) => m.role === 'assistant');
    // Thinking must LEAD the turn, before tool_use.
    expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: THINKING, signature: SIG });
    expect(assistant.content[1].type).toBe('tool_use');
    // And thinking stays ON for the continuation, which is the whole point.
    expect(sent.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('reassembles a streamed block from its thinking and signature deltas', async () => {
    streamFetch([
      'event: content_block_start\n' +
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      'event: content_block_delta\n' +
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me ' },
        }),
      'event: content_block_delta\n' +
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'check.' },
        }),
      'event: content_block_delta\n' +
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: SIG },
        }),
      'event: message_delta\n' + sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    ]);
    const r = await anthropicChatAdapter.chatStream!(
      { apiKey: 'k', model: 'claude-opus-4-8', messages: USER, thinkingBudget: 2048 },
      () => {},
    );
    // Fragments concatenated in order — the signature is validated against the
    // complete text, so a dropped or reordered fragment breaks the replay.
    expect(r.reasoningDetails).toEqual([
      { type: 'reasoning.text', index: 0, text: 'Let me check.', signature: SIG },
    ]);
  });
});

// ─── Gemini ─────────────────────────────────────────────────────────────────

describe('google-chat thought signatures', () => {
  const SIG = 'gemini-thought-sig-abc';

  const responseWithSignedCall = {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: { name: 'get_time', args: { tz: 'UTC' } },
              thoughtSignature: SIG,
            },
          ],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {},
    modelVersion: 'gemini-3-flash',
  };

  it('captures the signature keyed to the synthetic call id', async () => {
    captureFetch(responseWithSignedCall);
    const r = await googleChatAdapter.chat({
      apiKey: 'k',
      model: 'gemini-3-flash',
      messages: USER,
    });
    expect(r.toolCalls).toHaveLength(1);
    expect(r.reasoningDetails).toEqual([
      { type: 'reasoning.signature', id: r.toolCalls![0]!.id, signature: SIG },
    ]);
  });

  it('replays the signature onto the functionCall part it came from', async () => {
    captureFetch(responseWithSignedCall);
    const first = await googleChatAdapter.chat({
      apiKey: 'k',
      model: 'gemini-3-flash',
      messages: USER,
    });

    const calls = captureFetch(responseWithSignedCall);
    await googleChatAdapter.chat({
      apiKey: 'k',
      model: 'gemini-3-flash',
      messages: [
        ...USER,
        {
          role: 'assistant',
          content: null,
          toolCalls: first.toolCalls!,
          reasoningDetails: first.reasoningDetails,
        },
        { role: 'tool', toolCallId: first.toolCalls![0]!.id, content: '12:00' },
      ],
    });

    const sent = JSON.parse(calls[0]!.body);
    const modelTurn = sent.contents.find((c: { role: string }) => c.role === 'model');
    // Sibling key on the part, NOT inside functionCall.
    expect(modelTurn.parts[0]).toEqual({
      functionCall: { name: 'get_time', args: { tz: 'UTC' } },
      thoughtSignature: SIG,
    });
  });

  // Without the documented sentinel, a Gemini 3 replay with no signature 400s.
  it('injects the skip sentinel on gemini-3 when no signature was captured', async () => {
    const calls = captureFetch(responseWithSignedCall);
    await googleChatAdapter.chat({
      apiKey: 'k',
      model: 'gemini-3-flash',
      messages: [
        ...USER,
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'get_time', arguments: '{}' } },
          ],
        },
        { role: 'tool', toolCallId: 'c1', content: '12:00' },
      ],
    });
    const sent = JSON.parse(calls[0]!.body);
    const modelTurn = sent.contents.find((c: { role: string }) => c.role === 'model');
    expect(modelTurn.parts[0].thoughtSignature).toBe('skip_thought_signature_validator');
  });

  // Pre-3 models don't validate signatures, so the sentinel is noise there.
  it('does not inject the sentinel on a pre-3 model', async () => {
    const calls = captureFetch(responseWithSignedCall);
    await googleChatAdapter.chat({
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      messages: [
        ...USER,
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'get_time', arguments: '{}' } },
          ],
        },
        { role: 'tool', toolCallId: 'c1', content: '12:00' },
      ],
    });
    const sent = JSON.parse(calls[0]!.body);
    const modelTurn = sent.contents.find((c: { role: string }) => c.role === 'model');
    expect(modelTurn.parts[0].thoughtSignature).toBeUndefined();
  });

  // Gemini 3 returns ONE signature for a parallel-call response, on the first
  // call; the rest legitimately have none. Sentinelling those would override a
  // turn that is already validly signed.
  it('leaves unsigned sibling calls alone when the turn carries a real signature', async () => {
    const calls = captureFetch(responseWithSignedCall);
    await googleChatAdapter.chat({
      apiKey: 'k',
      model: 'gemini-3-flash',
      messages: [
        ...USER,
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
          ],
          reasoningDetails: [{ type: 'reasoning.signature', id: 'c1', signature: SIG }],
        },
        { role: 'tool', toolCallId: 'c1', content: 'ok' },
      ],
    });
    const sent = JSON.parse(calls[0]!.body);
    const modelTurn = sent.contents.find((c: { role: string }) => c.role === 'model');
    expect(modelTurn.parts[0].thoughtSignature).toBe(SIG);
    expect(modelTurn.parts[1].thoughtSignature).toBeUndefined();
  });
});

// ─── the guard ──────────────────────────────────────────────────────────────

describe('thinking guard', () => {
  const toolTurn = (reasoningDetails?: unknown): ChatToolLoopMessage =>
    ({
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      ...(reasoningDetails ? { reasoningDetails } : {}),
    }) as ChatToolLoopMessage;

  it('thinks on the first round, where there is nothing to replay', () => {
    expect(
      wantGuardedThinking({ apiKey: 'k', model: 'm', messages: USER, thinkingBudget: 1 }),
    ).toBe(true);
  });

  it('keeps thinking on a continuation whose tool turn carries reasoning', () => {
    const messages = [...USER, toolTurn([{ type: 'reasoning.text', text: 't', signature: 's' }])];
    expect(wantGuardedThinking({ apiKey: 'k', model: 'm', messages, thinkingBudget: 1 })).toBe(
      true,
    );
  });

  // The pre-existing safe behaviour, still required for histories recorded
  // before capture existed.
  it('suppresses thinking when a tool turn has no reasoning to replay', () => {
    const messages = [...USER, toolTurn()];
    expect(wantGuardedThinking({ apiKey: 'k', model: 'm', messages, thinkingBudget: 1 })).toBe(
      false,
    );
  });

  // All-or-nothing: a partially-replayable history is exactly the shape the
  // provider rejects, so it must suppress rather than send a broken turn.
  it('suppresses when only SOME tool turns can be replayed', () => {
    const messages = [
      ...USER,
      toolTurn([{ type: 'reasoning.text', text: 't', signature: 's' }]),
      toolTurn(),
    ];
    expect(canReplayReasoning(messages)).toBe(false);
    expect(wantGuardedThinking({ apiKey: 'k', model: 'm', messages, thinkingBudget: 1 })).toBe(
      false,
    );
  });

  it('stays off without a positive budget regardless of replayability', () => {
    const messages = [...USER, toolTurn([{ type: 'reasoning.text', text: 't', signature: 's' }])];
    expect(wantGuardedThinking({ apiKey: 'k', model: 'm', messages, thinkingBudget: 0 })).toBe(
      false,
    );
  });
});
