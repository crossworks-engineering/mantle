import { describe, it, expect, vi } from 'vitest';
import {
  ChatHttpError,
  classifyChatError,
  isEmptyJsonBodyError,
  parseRetryAfterMs,
  withChatRetry,
  DEFAULT_MAX_RETRIES,
} from './retry';
import type { ChatDispatcher, ChatOptions, ChatResult } from './types';

const OPTS: ChatOptions = {
  apiKey: 'k',
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
};

const RESULT: ChatResult = { text: 'ok', model: 'test-model' };

/** Build a chat dispatcher whose `chat` runs the supplied impl. Backoff is
 *  forced to 0 so tests don't wait on real timers. */
function dispatcherFrom(chat: (opts: ChatOptions) => Promise<ChatResult>): ChatDispatcher {
  return {
    providerId: 'anthropic',
    adapterName: 'anthropic-chat',
    chat,
    discoverModels: vi.fn() as unknown as ChatDispatcher['discoverModels'],
    staticCatalog: () => [],
  };
}

function wrap(chat: (opts: ChatOptions) => Promise<ChatResult>): ChatDispatcher {
  return withChatRetry(dispatcherFrom(chat), { baseDelayMs: 0, maxDelayMs: 0 });
}

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '2' }))).toBe(2000);
  });
  it('returns undefined when absent', () => {
    expect(parseRetryAfterMs(new Headers())).toBeUndefined();
  });
  it('tolerates missing/!Headers headers', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});

describe('classifyChatError', () => {
  it('retries retryable HTTP statuses', () => {
    for (const s of [408, 409, 425, 429, 500, 502, 503, 504]) {
      expect(classifyChatError(new ChatHttpError({ provider: 'x', status: s })).retry).toBe(true);
    }
  });
  it('does not retry non-retryable statuses', () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(classifyChatError(new ChatHttpError({ provider: 'x', status: s })).retry).toBe(false);
    }
  });
  it('surfaces retryAfterMs from the error', () => {
    const e = new ChatHttpError({ provider: 'x', status: 429, retryAfterMs: 1234 });
    expect(classifyChatError(e)).toEqual({ retry: true, retryAfterMs: 1234 });
  });
  it('retries network TypeErrors and timeouts', () => {
    expect(classifyChatError(new TypeError('fetch failed')).retry).toBe(true);
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(classifyChatError(timeout).retry).toBe(true);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyChatError(abort).retry).toBe(true);
  });
  it('retries errors carrying a numeric status', () => {
    expect(classifyChatError({ status: 503 }).retry).toBe(true);
    expect(classifyChatError({ status: 401 }).retry).toBe(false);
  });
  it('retries an empty/truncated JSON body (upstream stall → unparseable 2xx)', () => {
    expect(classifyChatError(new SyntaxError('Unexpected end of JSON input')).retry).toBe(true);
    expect(classifyChatError(new SyntaxError('Unexpected end of input')).retry).toBe(true);
  });
  it('does not retry a complete-but-malformed JSON body (real parse bug)', () => {
    expect(
      classifyChatError(new SyntaxError('Unexpected token x in JSON at position 0')).retry,
    ).toBe(false);
  });
  it('does not retry an ordinary error', () => {
    expect(classifyChatError(new Error('boom')).retry).toBe(false);
  });
});

describe('isEmptyJsonBodyError', () => {
  it('matches only the end-of-input SyntaxError family', () => {
    expect(isEmptyJsonBodyError(new SyntaxError('Unexpected end of JSON input'))).toBe(true);
    expect(isEmptyJsonBodyError(new SyntaxError('Unexpected end of input'))).toBe(true);
    expect(isEmptyJsonBodyError(new SyntaxError('Unexpected token x in JSON'))).toBe(false);
    expect(isEmptyJsonBodyError(new TypeError('Unexpected end of JSON input'))).toBe(false);
    expect(isEmptyJsonBodyError(new Error('boom'))).toBe(false);
    expect(isEmptyJsonBodyError(null)).toBe(false);
  });
});

describe('withChatRetry', () => {
  it('returns on first success without retrying', async () => {
    const chat = vi.fn(async () => RESULT);
    const out = await wrap(chat).chat(OPTS);
    expect(out).toBe(RESULT);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('retries a transient error then succeeds', async () => {
    let n = 0;
    const chat = vi.fn(async () => {
      n += 1;
      if (n <= 2) throw new ChatHttpError({ provider: 'anthropic', status: 503 });
      return RESULT;
    });
    const out = await wrap(chat).chat(OPTS);
    expect(out).toBe(RESULT);
    expect(chat).toHaveBeenCalledTimes(3); // 1 + DEFAULT_MAX_RETRIES(2)
    expect(DEFAULT_MAX_RETRIES).toBe(2);
  });

  it('throws after exhausting retries', async () => {
    const chat = vi.fn(async () => {
      throw new ChatHttpError({ provider: 'anthropic', status: 429 });
    });
    await expect(wrap(chat).chat(OPTS)).rejects.toThrow(/anthropic chat 429/);
    expect(chat).toHaveBeenCalledTimes(1 + DEFAULT_MAX_RETRIES);
  });

  it('does not retry a non-retryable error', async () => {
    const chat = vi.fn(async () => {
      throw new ChatHttpError({ provider: 'anthropic', status: 401, body: 'nope' });
    });
    await expect(wrap(chat).chat(OPTS)).rejects.toThrow(/anthropic chat 401/);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('honors a per-call maxRetries override of 0', async () => {
    const chat = vi.fn(async () => {
      throw new ChatHttpError({ provider: 'anthropic', status: 503 });
    });
    await expect(wrap(chat).chat({ ...OPTS, maxRetries: 0 })).rejects.toThrow();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('preserves the other dispatcher members', () => {
    const wrapped = wrap(async () => RESULT);
    expect(wrapped.providerId).toBe('anthropic');
    expect(wrapped.adapterName).toBe('anthropic-chat');
    expect(typeof wrapped.discoverModels).toBe('function');
    expect(wrapped.staticCatalog?.()).toEqual([]);
  });
});
