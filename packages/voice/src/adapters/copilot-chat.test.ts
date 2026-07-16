/**
 * copilot-chat wire-shape lock-down.
 *
 * GitHub Copilot is OpenAI-compatible at the chat layer (covered by the
 * openai-compat suite), so this file pins the Copilot-specific bits:
 *   1. The token EXCHANGE (GitHub OAuth token → Copilot bearer) precedes the
 *      chat call, with the editor headers.
 *   2. Copilot editor headers + Bearer auth on the chat request.
 *   3. A pre-minted Copilot token (`tid=…`) skips the exchange.
 *   4. `reasoning_effort` is sent from `thinkingBudget`, and sampling params are
 *      dropped when reasoning is on.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { copilotChatAdapter } from './copilot-chat';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Route mock responses by URL: the token endpoint vs the chat endpoint. */
function routeFetch(opts: { token?: unknown; chat?: unknown }) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('copilot_internal/v2/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => opts.token ?? { token: 'tid=minted;exp=1', expires_at: 9999999999 },
      };
    }
    return { ok: true, status: 200, json: async () => opts.chat };
  }) as unknown as typeof fetch;
  return calls;
}

const reply = (over?: Record<string, unknown>) => ({
  model: 'gpt-5',
  choices: [{ message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 5, completion_tokens: 2 },
  ...over,
});

describe('copilot-chat token exchange + headers', () => {
  it('exchanges the GitHub OAuth token, then POSTs chat with the minted Bearer + editor headers', async () => {
    const calls = routeFetch({
      token: { token: 'tid=minted-abc;exp=1', expires_at: 9999999999 },
      chat: reply(),
    });
    await copilotChatAdapter.chat({
      apiKey: 'gho_oauth_exchange_1',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    });

    // 1) token exchange first
    expect(calls[0]!.url).toContain('https://api.github.com/copilot_internal/v2/token');
    const exHeaders = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(exHeaders.Authorization).toBe('token gho_oauth_exchange_1');

    // 2) chat call with the minted token + editor fingerprint
    expect(calls[1]!.url).toBe('https://api.githubcopilot.com/chat/completions');
    const h = (calls[1]!.init?.headers ?? {}) as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tid=minted-abc;exp=1');
    expect(h['Editor-Version']).toBe('vscode/1.104.1');
    expect(h['Copilot-Integration-Id']).toBe('vscode-chat');
    expect(h['x-initiator']).toBe('agent');
  });

  it('skips the exchange when the key is already a Copilot token (tid=)', async () => {
    const calls = routeFetch({ chat: reply() });
    await copilotChatAdapter.chat({
      apiKey: 'tid=already-a-token;exp=9',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Only the chat call — no token-exchange round-trip.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.githubcopilot.com/chat/completions');
    const h = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tid=already-a-token;exp=9');
  });
});

describe('copilot-chat reasoning', () => {
  it('sends reasoning_effort from thinkingBudget and drops sampling params', async () => {
    const calls = routeFetch({ chat: reply() });
    await copilotChatAdapter.chat({
      apiKey: 'tid=t;exp=9',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      thinkingBudget: 5000, // → 'medium'
      temperature: 0.7,
      topP: 0.9,
    });
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.reasoning_effort).toBe('medium');
    // Reasoning models reject sampling params — they must be absent.
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it('maps budget magnitude to the effort tier', async () => {
    for (const [budget, tier] of [
      [500, 'low'],
      [3000, 'medium'],
      [20000, 'high'],
    ] as const) {
      const calls = routeFetch({ chat: reply() });
      await copilotChatAdapter.chat({
        apiKey: 'tid=t;exp=9',
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        thinkingBudget: budget,
      });
      const body = JSON.parse(calls[0]!.init?.body as string);
      expect(body.reasoning_effort).toBe(tier);
    }
  });

  it('omits reasoning_effort when no budget is set (and keeps sampling params)', async () => {
    const calls = routeFetch({ chat: reply() });
    await copilotChatAdapter.chat({
      apiKey: 'tid=t;exp=9',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
    });
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.temperature).toBe(0.5);
  });
});

describe('copilot-chat error surface', () => {
  it('throws when model is missing', async () => {
    await expect(
      copilotChatAdapter.chat({
        apiKey: 'tid=t;exp=9',
        model: '',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/model required/);
  });

  it('throws when the key (OAuth token) is missing', async () => {
    await expect(
      copilotChatAdapter.chat({
        apiKey: '',
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/required/);
  });
});
