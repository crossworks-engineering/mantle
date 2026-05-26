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

vi.mock('@openrouter/sdk', () => ({
  OpenRouter: vi.fn().mockImplementation(() => ({
    chat: {
      send: vi.fn(async (req: { chatRequest: Record<string, unknown> }) => {
        sendCalls.push(req);
        return mockResult;
      }),
    },
  })),
}));

// Import AFTER vi.mock so the adapter picks up the mocked SDK.
import { openrouterChatAdapter } from './openrouter-chat';

function setMockResult(r: unknown) {
  mockResult = r;
}

afterEach(() => {
  sendCalls.length = 0;
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
    const messages = sendCalls[0]!.chatRequest.messages as Array<
      Record<string, unknown>
    >;
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
    const messages = sendCalls[0]!.chatRequest.messages as Array<
      Record<string, unknown>
    >;
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
