/**
 * openrouter-chat adapter — focused unit tests.
 *
 * The HTTP-level OR SDK call is mocked at the module boundary so we
 * can lock down:
 *   1. ChatOptions.messages → OR SDK message shape (incl. cache_control
 *      marker translation when opts.cacheControl is set)
 *   2. Usage round-trip from result.usage onto ChatResult (cache_read,
 *      cache_write, cost)
 *   3. Reply text extraction handles both string and array content
 *
 * The real network call is integration-tested separately; here we just
 * pin down the translation layer that has all the surface area for
 * silent bugs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Capture every `client.chat.send({chatRequest})` call so tests can
// assert on the wire shape. The mock returns whatever the test
// installs via `setMockResult`. Defined at module scope so vi.mock's
// hoisting can reference it.
const sendCalls: Array<{ chatRequest: Record<string, unknown> }> = [];
let mockResult: unknown = {
  model: 'anthropic/claude-haiku-4.5',
  choices: [{ message: { role: 'assistant', content: 'hi' } }],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
};
// Per-test override of the SDK's send behaviour (e.g. throw N times then
// succeed, to exercise the empty-body retry). Null ⇒ the default: return
// mockResult. Receives the 1-based call count so a test can branch on attempt.
let mockSendImpl: ((call: number) => Promise<unknown>) | null = null;

// The adapter does `new OpenRouter(...)`, so this stand-in has to be
// CONSTRUCTIBLE. It used to be `vi.fn().mockImplementation(() => ({...}))`,
// which worked under vitest 2 but not 4: vitest 4 forwards `new` to the
// implementation, and an arrow function can't be constructed
// ("... is not a constructor"). A class says what it is and works either way.
vi.mock('@openrouter/sdk', () => ({
  OpenRouter: class {
    chat = {
      send: vi.fn(async (req: { chatRequest: Record<string, unknown> }) => {
        sendCalls.push(req);
        if (mockSendImpl) return mockSendImpl(sendCalls.length);
        return mockResult;
      }),
    };
  },
}));

// Import AFTER vi.mock so the adapter picks up the mocked SDK.
import { openrouterChatAdapter } from './openrouter-chat';

// The REAL outbound schema. `vi.mock('@openrouter/sdk')` above replaces that
// exact module id only, so this subpath import is the genuine article — which is
// the whole point: it lets these tests assert on the body that actually goes on
// the wire, not merely the object we hand the SDK.
import { ChatRequest$outboundSchema } from '@openrouter/sdk/models';

function setMockResult(r: unknown) {
  mockResult = r;
}

/** Serialise a captured request exactly as the SDK would before sending. */
function wireBody(call = 0): Record<string, unknown> {
  return ChatRequest$outboundSchema.parse(sendCalls[call]!.chatRequest) as unknown as Record<
    string,
    unknown
  >;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const toSnake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Every field we hand the SDK must survive its outbound zod schema.
 *
 * This is the guard that was missing. The schema DISCARDS unknown keys rather
 * than throwing, so an invented field name is a silent runtime no-op — it type
 * checks (before the cast was narrowed), it tests green (the SDK is mocked, so
 * serialisation never runs), and it simply never reaches OpenRouter. Two fields
 * lived that way for the life of the adapter: `reasoning.maxTokens` and a
 * `usage` flag that should have been `streamOptions.includeUsage`.
 *
 * Walks nested objects too, because that is where the reasoning bug hid: the
 * top-level `reasoning` key survived while its only child was thrown away.
 * camelCase→snake_case renaming is expected and not a drop.
 */
function findDroppedKeys(input: unknown, output: unknown, path = ''): string[] {
  if (!isPlainObject(input) || !isPlainObject(output)) return [];
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const outKey = key in output ? key : toSnake(key) in output ? toSnake(key) : null;
    if (outKey === null) {
      dropped.push(`${path}${key}`);
      continue;
    }
    dropped.push(...findDroppedKeys(value, output[outKey], `${path}${key}.`));
  }
  return dropped;
}

afterEach(() => {
  // Applies to EVERY test in this file: whatever request a test provoked, assert
  // the SDK would actually transmit all of it. New tests inherit the guard for
  // free, and a future SDK bump that renames a field fails here rather than in
  // production. `messages` is exempt — the schema legitimately restructures
  // content blocks, and message translation has its own dedicated assertions.
  for (const [i, call] of sendCalls.entries()) {
    const { messages: _messages, ...rest } = call.chatRequest;
    const dropped = findDroppedKeys(rest, wireBody(i));
    expect(dropped, `call ${i}: field(s) silently discarded by the SDK`).toEqual([]);
  }
  sendCalls.length = 0;
  mockSendImpl = null;
});

describe('openrouter-chat message translation', () => {
  it('sends a plain-string system message when no cacheControl is set', async () => {
    setMockResult({
      model: 'anthropic/claude-haiku-4.5',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-haiku-4.5',
      messages: [
        { role: 'system', content: 'you are saskia' },
        { role: 'user', content: 'hi' },
      ],
    });
    const sent = sendCalls[0]!.chatRequest;
    const messages = sent.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'you are saskia' });
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('wraps system in a content-block array with cacheControl when cacheControl.systemPrompt is set', async () => {
    setMockResult({
      model: 'anthropic/claude-haiku-4.5',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-haiku-4.5',
      messages: [
        { role: 'system', content: 'you are saskia' },
        { role: 'user', content: 'hi' },
      ],
      cacheControl: { systemPrompt: true },
    });
    const messages = sendCalls[0]!.chatRequest.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'you are saskia',
          cacheControl: { type: 'ephemeral' },
        },
      ],
    });
    // The user message stays a plain string when only systemPrompt is set.
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('marks ONLY the last user message when cacheControl.lastUserMessage is set', async () => {
    setMockResult({
      model: 'anthropic/claude-haiku-4.5',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-haiku-4.5',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      cacheControl: { lastUserMessage: true },
    });
    const messages = sendCalls[0]!.chatRequest.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'user', content: 'first' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'reply' });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'second',
          cacheControl: { type: 'ephemeral' },
        },
      ],
    });
  });

  it('moves the tail marker onto the trailing tool result on iter 2+ (not the original question)', async () => {
    // Tool-loop iter 2+ shape: the genuinely-last message is a `tool`
    // result, not a user message. The cache breakpoint must advance onto
    // it so the growing tool-result tail caches — anchoring on the last
    // user message (the original question) pins the marker near the front
    // and re-sends the tail uncached every round. Safety net for the
    // docs/audit-chat-cost-2026-06-07.md finding (b) fix.
    setMockResult({
      model: 'anthropic/claude-4.6-sonnet',
      choices: [{ message: { role: 'assistant', content: 'done' } }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-4.6-sonnet',
      messages: [
        { role: 'user', content: 'the question' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } }],
        },
        { role: 'tool', toolCallId: 'call_1', content: 'tool output' },
      ],
      cacheControl: { systemPrompt: true, lastUserMessage: true },
    });
    const messages = sendCalls[0]!.chatRequest.messages as Array<Record<string, unknown>>;
    // Original question stays an unmarked plain string.
    expect(messages[0]).toEqual({ role: 'user', content: 'the question' });
    // The marker lands on the trailing tool result.
    expect(messages[2]).toEqual({
      role: 'tool',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'tool output', cacheControl: { type: 'ephemeral' } }],
    });
  });

  it('forwards temperature, maxTokens, topP', async () => {
    setMockResult({
      model: 'anthropic/claude-haiku-4.5',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-haiku-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      maxTokens: 200,
      topP: 0.9,
    });
    const sent = sendCalls[0]!.chatRequest;
    expect(sent.temperature).toBe(0.5);
    expect(sent.maxTokens).toBe(200);
    expect(sent.topP).toBe(0.9);
  });
});

describe('openrouter-chat multi-block + multimodal content', () => {
  it('applies cacheControl.systemPrompt to ONLY the last system message when multiple strings are present (caps under Anthropic 4-marker limit)', async () => {
    // Regression: buildChatMessages emits a per-block-marked persona system
    // (array form) PLUS string-system blocks for content hits / relations /
    // chunks. The OR adapter used to fire a marker on every plain-string
    // system, blowing Anthropic's "max 4 cache_control blocks" cap whenever
    // a few optional system blocks coexisted with caller-pre-marked array
    // system content. Now: caller-pre-marked → systemPrompt flag is ignored.
    setMockResult({
      model: 'anthropic/claude-sonnet-4.6',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-sonnet-4.6',
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'persona', cacheControl: { type: 'ephemeral' } }],
        },
        {
          role: 'system',
          content: [{ type: 'text', text: 'digest', cacheControl: { type: 'ephemeral' } }],
        },
        { role: 'system', content: 'content hits' },
        { role: 'system', content: 'relations' },
        { role: 'system', content: 'chunks' },
        { role: 'user', content: 'hi' },
      ],
      cacheControl: { systemPrompt: true, lastUserMessage: true },
    });
    const messages = sendCalls[0]!.chatRequest.messages as Array<Record<string, unknown>>;
    // Count cache_control markers across the whole request — must be ≤ 4
    // (Anthropic's hard cap). Pre-marked persona (1) + digest (1) + lastUser
    // (1) = 3. The string-system blocks must NOT receive markers because
    // the caller already pre-marked the cacheable prefix.
    let markerCount = 0;
    for (const m of messages) {
      const content = m.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.cacheControl) markerCount += 1;
        }
      }
    }
    expect(markerCount).toBe(3);
    // The string-system blocks should round-trip unchanged.
    expect(messages[2]).toEqual({ role: 'system', content: 'content hits' });
    expect(messages[3]).toEqual({ role: 'system', content: 'relations' });
    expect(messages[4]).toEqual({ role: 'system', content: 'chunks' });
  });

  it('with all-string system + systemPrompt flag, marks ONLY the LAST system message', async () => {
    // When no per-block markers exist on any system message, cacheControl.
    // systemPrompt is satisfied by adding exactly one marker on the LAST
    // system message (longest cacheable prefix). Previous behaviour put a
    // marker on every plain-string system — which 5+-system requests blew.
    setMockResult({
      model: 'anthropic/claude-sonnet-4.6',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-sonnet-4.6',
      messages: [
        { role: 'system', content: 'persona' },
        { role: 'system', content: 'digests' },
        { role: 'system', content: 'tail' },
        { role: 'user', content: 'hi' },
      ],
      cacheControl: { systemPrompt: true },
    });
    const messages = sendCalls[0]!.chatRequest.messages as Array<Record<string, unknown>>;
    // First two system messages remain plain strings.
    expect(messages[0]).toEqual({ role: 'system', content: 'persona' });
    expect(messages[1]).toEqual({ role: 'system', content: 'digests' });
    // Last system gets the single ephemeral marker.
    expect(messages[2]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'tail', cacheControl: { type: 'ephemeral' } }],
    });
  });

  it('passes array-shape system through with per-block cacheControl preserved', async () => {
    setMockResult({
      model: 'anthropic/claude-sonnet-4.6',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-sonnet-4.6',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'persona',
              cacheControl: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: 'digest',
              cacheControl: { type: 'ephemeral' },
            },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
    });
    const sent = sendCalls[0]!.chatRequest;
    const messages = sent.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: 'persona', cacheControl: { type: 'ephemeral' } },
        { type: 'text', text: 'digest', cacheControl: { type: 'ephemeral' } },
      ],
    });
  });

  it('translates multimodal user content to OR SDK shape (imageUrl camelCase)', async () => {
    setMockResult({
      model: 'anthropic/claude-sonnet-4.6',
      choices: [{ message: { role: 'assistant', content: 'I see a cat' } }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-sonnet-4.6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image_url',
              imageUrl: {
                url: 'data:image/png;base64,abc',
                detail: 'high',
              },
            },
          ],
        },
      ],
    });
    const sent = sendCalls[0]!.chatRequest;
    const messages = sent.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        {
          type: 'image_url',
          imageUrl: { url: 'data:image/png;base64,abc', detail: 'high' },
        },
      ],
    });
  });
});

describe('openrouter-chat usage round-trip', () => {
  it('surfaces tokensIn/tokensOut from usage.promptTokens / completionTokens', async () => {
    setMockResult({
      model: 'anthropic/claude-haiku-4.5',
      choices: [{ message: { role: 'assistant', content: 'reply' } }],
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });
    const result = await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-haiku-4.5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(20);
    expect(result.text).toBe('reply');
  });

  it('surfaces cacheReadTokens + cacheWriteTokens from promptTokensDetails', async () => {
    setMockResult({
      model: 'anthropic/claude-sonnet-4.6',
      choices: [{ message: { role: 'assistant', content: 'r' } }],
      usage: {
        promptTokens: 1000,
        completionTokens: 50,
        totalTokens: 1050,
        promptTokensDetails: {
          cachedTokens: 800,
          cacheWriteTokens: 100,
        },
      },
    });
    const result = await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.cacheReadTokens).toBe(800);
    expect(result.cacheWriteTokens).toBe(100);
  });

  it('surfaces reportedCostUsd from usage.cost', async () => {
    setMockResult({
      model: 'anthropic/claude-haiku-4.5',
      choices: [{ message: { role: 'assistant', content: 'r' } }],
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cost: 0.0042,
      },
    });
    const result = await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-haiku-4.5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.reportedCostUsd).toBeCloseTo(0.0042, 6);
  });

  it('leaves reportedCostUsd undefined when OR omits cost', async () => {
    setMockResult({
      model: 'anthropic/claude-haiku-4.5',
      choices: [{ message: { role: 'assistant', content: 'r' } }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const result = await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-haiku-4.5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.reportedCostUsd).toBeUndefined();
  });
});

describe('openrouter-chat reply extraction', () => {
  it('handles array-shaped content (some routes return content blocks)', async () => {
    setMockResult({
      model: 'anthropic/claude-haiku-4.5',
      choices: [
        {
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'part one ' },
              { type: 'text', text: 'part two' },
            ],
          },
        },
      ],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const result = await openrouterChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'anthropic/claude-haiku-4.5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.text).toBe('part one part two');
  });
});

describe('openrouter-chat error surface', () => {
  it('throws a clear error when apiKey is missing', async () => {
    await expect(
      openrouterChatAdapter.chat({
        apiKey: '',
        model: 'anthropic/claude-haiku-4.5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/apiKey required/);
  });

  it('throws a clear error when model is missing', async () => {
    await expect(
      openrouterChatAdapter.chat({
        apiKey: 'sk-test',
        model: '',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/model required/);
  });
});

describe('openrouter-chat empty-body retry', () => {
  // The prod incident: an upstream stall returned an empty 2xx body, the SDK's
  // JSON.parse threw "Unexpected end of JSON input", and the whole turn died
  // with a context-free error and no retry. These pin the fix.
  it('retries an empty/truncated-body parse error, then succeeds', async () => {
    vi.useFakeTimers();
    try {
      mockSendImpl = async (call) => {
        if (call === 1) throw new SyntaxError('Unexpected end of JSON input');
        return {
          model: 'anthropic/claude-sonnet-4.6',
          choices: [{ message: { role: 'assistant', content: 'recovered' } }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      };
      const p = openrouterChatAdapter.chat({
        apiKey: 'sk-test',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'hi' }],
      });
      await vi.advanceTimersByTimeAsync(10_000); // pump the backoff sleep
      const result = await p;
      expect(result.text).toBe('recovered');
      expect(sendCalls.length).toBe(2); // first attempt threw, retry succeeded
    } finally {
      vi.useRealTimers();
    }
  });

  it('exhausts retries and throws a contextful error naming the model (not the bare parse message)', async () => {
    vi.useFakeTimers();
    try {
      mockSendImpl = async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      };
      const p = openrouterChatAdapter.chat({
        apiKey: 'sk-test',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'hi' }],
        maxRetries: 2,
      });
      // Attach the rejection matcher BEFORE pumping timers so the eventual
      // rejection always has a handler (no unhandled-rejection noise).
      const assertion = expect(p).rejects.toThrow(
        /empty or truncated response from anthropic\/claude-sonnet-4\.6/,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(sendCalls.length).toBe(3); // 1 initial + 2 retries
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT retry a complete-but-malformed JSON body (only end-of-input)', async () => {
    mockSendImpl = async () => {
      // A genuine parse bug, not a truncated body — must surface immediately.
      throw new SyntaxError('Unexpected token x in JSON at position 0');
    };
    await expect(
      openrouterChatAdapter.chat({
        apiKey: 'sk-test',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/Unexpected token x/);
    expect(sendCalls.length).toBe(1); // no retry
  });
});

// ── chatStream (Phase 3 token streaming) ─────────────────────────────────────
//
// The mocked SDK `send` returns whatever `mockSendImpl` yields; for streaming we
// hand back an async generator of chunk objects (an EventStream is just an async
// iterable at the call site). These lock down: deltas surface to onDelta, the
// resolved ChatResult is assembled identically to chat(), tool-call FRAGMENTS
// concatenate by index, and `stream`/`usage.include` ride the request.

/** Build an async-iterable of stream chunks (stands in for the SDK EventStream). */
function streamOf(chunks: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

describe('openrouter-chat chatStream', () => {
  it('sets stream + usage accounting on the request and assembles text from deltas', async () => {
    mockSendImpl = async () =>
      streamOf([
        { model: 'openai/gpt-4o', choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: { content: ' there' }, finishReason: 'stop' }] },
        { usage: { promptTokens: 7, completionTokens: 3, cost: 0.0004 } },
      ]);
    const deltas: Array<{ type: string; text: string }> = [];
    const r = await openrouterChatAdapter.chatStream!(
      { apiKey: 'sk-test', model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      (d) => deltas.push(d),
    );
    const req = sendCalls[0]!.chatRequest;
    expect(req.stream).toBe(true);
    // Was `expect(req.usage).toEqual({ include: true })` — green for the life of
    // the adapter while the flag never reached OpenRouter, because it asserted
    // the object we hand the SDK rather than the body the SDK emits. The real
    // field is streamOptions; 'serialised wire body' below pins the wire form.
    expect(req.streamOptions).toEqual({ includeUsage: true });
    expect(deltas).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'text', text: ' there' },
    ]);
    expect(r.text).toBe('Hello there');
    expect(r.tokensIn).toBe(7);
    expect(r.tokensOut).toBe(3);
    expect(r.reportedCostUsd).toBe(0.0004);
    expect(r.toolCalls).toBeUndefined();
  });

  it('assembles tool calls from streamed argument fragments (by index)', async () => {
    mockSendImpl = async () =>
      streamOf([
        {
          choices: [
            {
              delta: {
                toolCalls: [
                  { index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { toolCalls: [{ index: 0, function: { arguments: '"cats"}' } }] } }] },
        { choices: [{ delta: {}, finishReason: 'tool_calls' }] },
        { usage: { promptTokens: 12, completionTokens: 8 } },
      ]);
    const r = await openrouterChatAdapter.chatStream!(
      {
        apiKey: 'sk-test',
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'find cats' }],
      },
      () => {},
    );
    expect(r.text).toBe('');
    expect(r.toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"cats"}' } },
    ]);
  });

  it('surfaces reasoning deltas separately from text', async () => {
    mockSendImpl = async () =>
      streamOf([
        { choices: [{ delta: { reasoning: 'thinking…' } }] },
        { choices: [{ delta: { content: 'answer' }, finishReason: 'stop' }] },
      ]);
    const deltas: Array<{ type: string; text: string }> = [];
    const r = await openrouterChatAdapter.chatStream!(
      { apiKey: 'sk-test', model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'q' }] },
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual([
      { type: 'reasoning', text: 'thinking…' },
      { type: 'text', text: 'answer' },
    ]);
    expect(r.text).toBe('answer');
  });

  it('throws when a chunk carries an error envelope', async () => {
    mockSendImpl = async () =>
      streamOf([
        { choices: [{ delta: { content: 'par' } }] },
        { error: { code: 502, message: 'upstream boom' } },
      ]);
    await expect(
      openrouterChatAdapter.chatStream!(
        { apiKey: 'sk-test', model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        () => {},
      ),
    ).rejects.toThrow(/upstream boom/);
  });
});

/**
 * Wire-body assertions — what OpenRouter actually receives.
 *
 * Distinct from every other describe in this file: those assert the object the
 * adapter builds, these assert the bytes after the SDK's outbound schema has run.
 * That gap is where two silent no-ops lived undetected.
 */
describe('openrouter-chat serialised wire body', () => {
  const baseOpts = {
    apiKey: 'sk-test',
    model: 'anthropic/claude-sonnet-5',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('streamed calls really ask for usage accounting', async () => {
    // REGRESSION: shipped as `usage: { include: true }`, which is not a request
    // field — the schema dropped it and OR never folded usage into the final
    // chunk, so streamed cost tracking was reporting nothing. The correct field
    // serialises to snake_case.
    mockSendImpl = async () => streamOf([{ choices: [{ delta: { content: 'ok' } }] }]);
    await openrouterChatAdapter.chatStream!(baseOpts, () => {});

    expect(wireBody()).toMatchObject({ stream_options: { include_usage: true } });
    expect(wireBody()).not.toHaveProperty('usage');
  });

  it('one-shot calls send no stream_options', async () => {
    await openrouterChatAdapter.chat(baseOpts);
    expect(wireBody()).not.toHaveProperty('stream_options');
  });

  it('puts the effort tier on the wire', async () => {
    // This replaced a tripwire that asserted `reasoning: {}` — the shape the old
    // budget-based code actually emitted, i.e. thinking silently doing nothing.
    // The tripwire failing is what confirmed this fix landed.
    await openrouterChatAdapter.chat({ ...baseOpts, thinkingEffort: 'high' });
    expect(wireBody().reasoning).toEqual({ effort: 'high' });
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'effort %s survives serialisation',
    async (effort) => {
      await openrouterChatAdapter.chat({ ...baseOpts, thinkingEffort: effort });
      expect(wireBody().reasoning).toEqual({ effort });
    },
  );

  it('a budget WITHOUT an effort sends no reasoning at all', async () => {
    // The old failure mode, now impossible: a bare budget used to serialise to
    // `reasoning: {}`, which reads like reasoning was requested when nothing was.
    // Omitting the key entirely also keeps us off `effort: 'none'`, which
    // mandatory-reasoning models reject.
    await openrouterChatAdapter.chat({ ...baseOpts, thinkingBudget: 4096 });
    expect(wireBody()).not.toHaveProperty('reasoning');
  });

  it('omits reasoning entirely when nothing is set', async () => {
    await openrouterChatAdapter.chat(baseOpts);
    expect(wireBody()).not.toHaveProperty('reasoning');
  });

  it('sampling params and tool_choice survive serialisation', async () => {
    await openrouterChatAdapter.chat({
      ...baseOpts,
      temperature: 0.4,
      maxTokens: 1024,
      topP: 0.9,
      toolChoice: 'auto',
      tools: [
        {
          type: 'function',
          function: { name: 'search', description: 'find', parameters: { type: 'object' } },
        },
      ],
    });

    expect(wireBody()).toMatchObject({
      temperature: 0.4,
      max_tokens: 1024,
      top_p: 0.9,
      tool_choice: 'auto',
    });
  });
});
