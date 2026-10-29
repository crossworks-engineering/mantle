import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_TIMEOUTS } from '@mantle/std';
import type { ProviderFetchOptions } from './provider-fetch';

/**
 * Every chat adapter states its deadline to providerFetch (A10 #10 fix round
 * 1). Before, the one-shot deadlines rode only on `init.signal`, so the pool's
 * 180 s default still fired first: a local model call allowed 300 s was cut at
 * 180 s, retried, then failed over to a paid cloud route. And every stream
 * says its deadline covers the headers only, whatever the answer's type.
 */

type Seen = { url: string; opts: ProviderFetchOptions | undefined };
const seen: Seen[] = [];

vi.mock('./provider-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider-fetch')>();
  return {
    ...actual,
    providerFetch: vi.fn(async (url: string, _init?: RequestInit, opts?: ProviderFetchOptions) => {
      seen.push({ url: String(url), opts });
      return new Response('', { status: 503 });
    }),
  };
});

const { localChatAdapter } = await import('./local-chat');
const { anthropicChatAdapter } = await import('./anthropic-chat');
const { googleChatAdapter } = await import('./google-chat');
const { xaiChatAdapter } = await import('./xai-chat');
const { huggingfaceChatAdapter } = await import('./huggingface-chat');
const { deepseekChatAdapter } = await import('./deepseek-chat');
const { copilotChatAdapter } = await import('./copilot-chat');
const { mammouthChatAdapter } = await import('./mammouth-chat');
const { customChatAdapter } = await import('./custom-chat');
const { foundryChatAdapter } = await import('./foundry-chat');

const base = {
  apiKey: 'k;tid=1',
  model: 'm',
  baseUrl: 'http://127.0.0.1:9/v1',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

async function lastOpts(run: () => Promise<unknown>): Promise<ProviderFetchOptions | undefined> {
  seen.length = 0;
  await run().catch(() => undefined); // the 503 throws; only the options matter
  return seen.at(-1)?.opts;
}

afterEach(() => {
  seen.length = 0;
});

describe('local chat keeps its 300 s', () => {
  it('one-shot names LOCAL 300 s to providerFetch', async () => {
    const opts = await lastOpts(() =>
      localChatAdapter.chat({ ...base, signal: new AbortController().signal }),
    );
    expect(opts).toEqual({ timeoutMs: PROVIDER_TIMEOUTS.chatLocal });
    expect(PROVIDER_TIMEOUTS.chatLocal).toBe(300_000);
  });

  it('stream names 300 s for the headers only', async () => {
    const opts = await lastOpts(() => localChatAdapter.chatStream!({ ...base }, () => {}));
    expect(opts).toEqual({ timeoutMs: 300_000, timeoutScope: 'headers' });
  });
});

describe('every one-shot chat call names its deadline', () => {
  const cases = [
    ['anthropic', anthropicChatAdapter, PROVIDER_TIMEOUTS.chat],
    ['google', googleChatAdapter, PROVIDER_TIMEOUTS.chat],
    ['xai', xaiChatAdapter, PROVIDER_TIMEOUTS.chat],
    ['huggingface', huggingfaceChatAdapter, PROVIDER_TIMEOUTS.chat],
    ['deepseek', deepseekChatAdapter, PROVIDER_TIMEOUTS.chat],
    ['copilot', copilotChatAdapter, PROVIDER_TIMEOUTS.chatRelay],
    ['mammouth', mammouthChatAdapter, PROVIDER_TIMEOUTS.chatRelay],
    ['custom', customChatAdapter, PROVIDER_TIMEOUTS.chatRelay],
  ] as const;
  for (const [name, adapter, ms] of cases) {
    it(`${name}: { timeoutMs: ${ms} }`, async () => {
      const opts = await lastOpts(() => adapter.chat({ ...base }));
      expect(opts).toEqual({ timeoutMs: ms });
    });
  }
  // Foundry takes https endpoints only, so it gets one of its own.
  it(`foundry: { timeoutMs: ${PROVIDER_TIMEOUTS.chatRelay} }`, async () => {
    const opts = await lastOpts(() =>
      foundryChatAdapter.chat({ ...base, baseUrl: 'https://foundry-a.example.invalid' }),
    );
    expect(opts).toEqual({ timeoutMs: PROVIDER_TIMEOUTS.chatRelay });
  });
});

describe('every stream says its deadline covers the headers only', () => {
  const cases = [
    ['anthropic', anthropicChatAdapter],
    ['google', googleChatAdapter],
    ['xai', xaiChatAdapter],
    ['huggingface', huggingfaceChatAdapter],
    ['deepseek', deepseekChatAdapter],
    ['copilot', copilotChatAdapter],
    ['mammouth', mammouthChatAdapter],
    ['custom', customChatAdapter],
  ] as const;
  for (const [name, adapter] of cases) {
    it(name, async () => {
      const opts = await lastOpts(() => adapter.chatStream!({ ...base }, () => {}));
      expect(opts).toEqual({
        timeoutMs: PROVIDER_TIMEOUTS.streamConnect,
        timeoutScope: 'headers',
      });
    });
  }
  it('foundry', async () => {
    const opts = await lastOpts(() =>
      foundryChatAdapter.chatStream!(
        { ...base, baseUrl: 'https://foundry-a.example.invalid' },
        () => {},
      ),
    );
    expect(opts).toEqual({
      timeoutMs: PROVIDER_TIMEOUTS.streamConnect,
      timeoutScope: 'headers',
    });
  });
});
