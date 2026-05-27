/**
 * Locks down the chat-shaped worker's contract-forwarding behaviour.
 *
 * The extractor's `chatComplete` helper is what every node ingest
 * (and every fact-classifier slow path) calls. Two things this test
 * pins down that production silently relied on:
 *
 *   1. cacheControl: { systemPrompt: true } is set on every call. This
 *      is the dominant cost-saving on Anthropic-direct extractor runs
 *      — without it the 2K-token system prompt pays full input rate
 *      per node instead of cache-read rate on second+ ingests within
 *      the 5-min TTL.
 *
 *   2. Params (temperature, max_tokens, top_p) are forwarded.
 *
 * The summarizer + reflector wire the same flag inline (not via this
 * helper); the adapter-level tests in @mantle/voice's
 * chat-adapters.test.ts cover the translation of that flag to
 * provider-specific cache_control markers, so we don't need to
 * exhaustively re-test those paths here.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ChatDispatcher,
  ChatOptions,
  ChatResult,
} from '@mantle/voice';
import { chatComplete } from './extractor';

function makeFakeAdapter(): {
  adapter: ChatDispatcher;
  calls: ChatOptions[];
} {
  const calls: ChatOptions[] = [];
  const adapter: ChatDispatcher = {
    providerId: 'anthropic',
    adapterName: 'anthropic-chat',
    chat: vi.fn(async (opts: ChatOptions): Promise<ChatResult> => {
      calls.push(opts);
      return {
        text: '{"summary":"ok","entities":[],"facts":[]}',
        model: 'claude-haiku-4-5',
        tokensIn: 200,
        tokensOut: 50,
      };
    }),
  };
  return { adapter, calls };
}

describe('extractor.chatComplete', () => {
  it('sets cacheControl.systemPrompt on every call', async () => {
    const { adapter, calls } = makeFakeAdapter();
    await chatComplete(
      adapter,
      'sk-test',
      'claude-haiku-4-5',
      'you are a memory extractor',
      'Title: hi\n\nBody: a',
      {},
    );
    expect(calls[0]!.cacheControl).toEqual({ systemPrompt: true });
  });

  it('forwards params (temperature, max_tokens, top_p) when set', async () => {
    const { adapter, calls } = makeFakeAdapter();
    await chatComplete(
      adapter,
      'sk-test',
      'claude-haiku-4-5',
      'system',
      'user',
      { temperature: 0.2, max_tokens: 500, top_p: 0.9 },
    );
    expect(calls[0]!.temperature).toBe(0.2);
    expect(calls[0]!.maxTokens).toBe(500);
    expect(calls[0]!.topP).toBe(0.9);
  });

  it('omits params from the call when not set', async () => {
    const { adapter, calls } = makeFakeAdapter();
    await chatComplete(
      adapter,
      'sk-test',
      'claude-haiku-4-5',
      'system',
      'user',
      {},
    );
    expect(calls[0]!.temperature).toBeUndefined();
    expect(calls[0]!.maxTokens).toBeUndefined();
    expect(calls[0]!.topP).toBeUndefined();
  });

  it('passes the system + user as a two-message array', async () => {
    const { adapter, calls } = makeFakeAdapter();
    await chatComplete(
      adapter,
      'sk-test',
      'claude-haiku-4-5',
      'you are saskia',
      'extract this',
      {},
    );
    expect(calls[0]!.messages).toEqual([
      { role: 'system', content: 'you are saskia' },
      { role: 'user', content: 'extract this' },
    ]);
  });
});
