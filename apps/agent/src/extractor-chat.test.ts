/**
 * Locks down the chat-shaped worker's contract-forwarding behaviour.
 *
 * The extractor's `chatComplete` helper is what every node ingest (and every
 * fact-classifier slow path) calls. Since the primary/backup failover work it
 * resolves its own adapter via `chatWithFailover`, so we partial-mock
 * `getChatAdapter` (keeping the rest of the @mantle/voice barrel intact, since
 * the extractor's import graph needs it) to capture the forwarded ChatOptions.
 *
 * Two things this test pins down that production silently relies on:
 *   1. cacheControl: { systemPrompt: true } is set on every call (the dominant
 *      cost-saving on Anthropic-direct extractor runs).
 *   2. Params (temperature, max_tokens, top_p) are forwarded.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatOptions } from '@mantle/voice';

const h = vi.hoisted(() => ({ calls: [] as ChatOptions[] }));

vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/voice')>();
  return {
    ...actual,
    getChatAdapter: () => ({
      providerId: 'anthropic',
      adapterName: 'anthropic-chat',
      chat: async (opts: ChatOptions) => {
        h.calls.push(opts);
        return {
          text: '{"summary":"ok","entities":[],"facts":[]}',
          model: 'claude-haiku-4-5',
          tokensIn: 200,
          tokensOut: 50,
        };
      },
    }),
  };
});

vi.mock('@mantle/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/api-keys')>();
  return { ...actual, getApiKey: async () => 'sk-test', getApiKeyById: async () => 'sk-test' };
});

import { chatComplete } from './extractor';
import type { ChatRoutes } from '@mantle/agent-runtime';

const ROUTES: ChatRoutes = {
  primary: { provider: 'anthropic', model: 'claude-haiku-4-5', apiKeyId: null },
  backup: null,
};

describe('extractor.chatComplete', () => {
  beforeEach(() => {
    h.calls = [];
  });

  it('sets cacheControl.systemPrompt on every call', async () => {
    await chatComplete('owner-1', ROUTES, 'you are a memory extractor', 'Title: hi\n\nBody: a', {});
    expect(h.calls[0]!.cacheControl).toEqual({ systemPrompt: true });
  });

  it('forwards params (temperature, max_tokens, top_p) when set', async () => {
    await chatComplete('owner-1', ROUTES, 'system', 'user', {
      temperature: 0.2,
      max_tokens: 500,
      top_p: 0.9,
    });
    expect(h.calls[0]!.temperature).toBe(0.2);
    expect(h.calls[0]!.maxTokens).toBe(500);
    expect(h.calls[0]!.topP).toBe(0.9);
  });

  it('omits params from the call when not set', async () => {
    await chatComplete('owner-1', ROUTES, 'system', 'user', {});
    expect(h.calls[0]!.temperature).toBeUndefined();
    expect(h.calls[0]!.maxTokens).toBeUndefined();
    expect(h.calls[0]!.topP).toBeUndefined();
  });

  it('passes the system + user as a two-message array', async () => {
    await chatComplete('owner-1', ROUTES, 'you are saskia', 'extract this', {});
    expect(h.calls[0]!.messages).toEqual([
      { role: 'system', content: 'you are saskia' },
      { role: 'user', content: 'extract this' },
    ]);
  });
});
