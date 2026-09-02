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
    // Real parse failures, not hand-written messages — see isEmptyJsonBodyError below.
    for (const body of ['', '   ', '{"id":', '{"id":"ms']) {
      let err: unknown;
      try {
        JSON.parse(body);
      } catch (e) {
        err = e;
      }
      expect(classifyChatError(err).retry, body || '(empty)').toBe(true);
    }
  });
  it('does not retry a complete-but-malformed JSON body (real parse bug)', () => {
    let err: unknown;
    try {
      JSON.parse('{"id":,}');
    } catch (e) {
      err = e;
    }
    expect(classifyChatError(err).retry).toBe(false);
  });
  it('does not retry an ordinary error', () => {
    expect(classifyChatError(new Error('boom')).retry).toBe(false);
  });
});

describe('isEmptyJsonBodyError', () => {
  /** The error a REAL `JSON.parse` throws for this body. Tests below assert
   *  against actual V8 output rather than hand-written message strings — the
   *  previous version of this suite asserted the strings, which is why it stayed
   *  green while V8 changed its wording and quietly narrowed what was matched. */
  const parseError = (body: string): unknown => {
    try {
      JSON.parse(body);
      throw new Error(`expected ${JSON.stringify(body)} to be unparseable`);
    } catch (e) {
      return e;
    }
  };

  it.each([
    ['an empty body', ''],
    ['a whitespace-only body', '   \n'],
    ['a body cut where a value was expected', '{"id":'],
    ['a body cut inside a string', '{"id":"ms'],
    ['a body cut inside a nested string', '{"choices":[{"content":"par'],
  ])('matches %s', (_label, body) => {
    expect(isEmptyJsonBodyError(parseError(body))).toBe(true);
  });

  it.each([
    ['a complete but malformed body', '{"id":,}'],
    ['a bare token', 'nope'],
  ])('does NOT match %s (a real bug, not a stall)', (_label, body) => {
    expect(isEmptyJsonBodyError(parseError(body))).toBe(false);
  });

  it('does not match non-SyntaxError failures', () => {
    expect(isEmptyJsonBodyError(new TypeError('Unexpected end of JSON input'))).toBe(false);
    expect(isEmptyJsonBodyError(new Error('boom'))).toBe(false);
    expect(isEmptyJsonBodyError(null)).toBe(false);
  });

  it('documents the shapes we knowingly leave uncovered', () => {
    // These fire for BOTH a mid-object truncation and a malformed-but-complete
    // body, and the message can't distinguish them. Retrying a genuine parse bug
    // is worse than missing a rarer stall shape, so they stay out — but they are
    // pinned here so a future widening is a deliberate edit, not an accident.
    expect(isEmptyJsonBodyError(parseError('{'))).toBe(false);
    expect(isEmptyJsonBodyError(parseError('{"id":"m"'))).toBe(false);
    expect(isEmptyJsonBodyError(parseError('{"n":12'))).toBe(false);
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

  it('does not retry when the caller-supplied signal is aborted (user Stop)', async () => {
    // A Stop aborts opts.signal; the adapter's fetch rejects with AbortError.
    // Retrying would abort identically after a pointless backoff sleep — the
    // wrapper must surface the error on the first attempt.
    const controller = new AbortController();
    controller.abort();
    const chat = vi.fn(async () => {
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    });
    await expect(wrap(chat).chat({ ...OPTS, signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('still retries a bare AbortError with NO caller signal (the 60s timeout case)', async () => {
    const chat = vi
      .fn(async (): Promise<ChatResult> => {
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      })
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      })
      .mockImplementationOnce(async () => RESULT);
    await expect(wrap(chat).chat(OPTS)).resolves.toEqual(RESULT);
    expect(chat).toHaveBeenCalledTimes(2);
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

// ─── chatStream (2026-09-02: live turns prefer the stream path) ──────────────

describe('withChatRetry chatStream', () => {
  type Stream = NonNullable<ChatDispatcher['chatStream']>;
  function streamingFrom(chatStream: Stream): ChatDispatcher {
    return { ...dispatcherFrom(async () => RESULT), chatStream };
  }
  function wrapStream(chatStream: Stream): ChatDispatcher {
    return withChatRetry(streamingFrom(chatStream), { baseDelayMs: 0, maxDelayMs: 0 });
  }
  const transient = () => new ChatHttpError({ provider: 'anthropic', status: 503 });

  it('retries a transient failure that happens before any delta reached the sink', async () => {
    let calls = 0;
    const a = wrapStream(async (_o, onDelta) => {
      calls += 1;
      if (calls === 1) throw transient();
      onDelta({ type: 'text', text: 'ok' });
      return RESULT;
    });
    const deltas: unknown[] = [];
    await expect(a.chatStream!(OPTS, (d) => deltas.push(d))).resolves.toEqual(RESULT);
    expect(calls).toBe(2);
    expect(deltas).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('retries a connect timeout (TimeoutError) before the first delta', async () => {
    let calls = 0;
    const a = wrapStream(async () => {
      calls += 1;
      if (calls === 1) throw new DOMException('connect timed out', 'TimeoutError');
      return RESULT;
    });
    await expect(a.chatStream!(OPTS, () => {})).resolves.toEqual(RESULT);
    expect(calls).toBe(2);
  });

  it('does NOT replay a stream that already emitted a delta (idle timeout mid-stream)', async () => {
    let calls = 0;
    const a = wrapStream(async (_o, onDelta) => {
      calls += 1;
      onDelta({ type: 'text', text: 'partial' });
      throw new DOMException('chat stream idle', 'TimeoutError');
    });
    await expect(a.chatStream!(OPTS, () => {})).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(calls).toBe(1);
  });

  it('does not retry when the caller-supplied signal is aborted (user Stop)', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const a = wrapStream(async () => {
      calls += 1;
      ctrl.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(a.chatStream!({ ...OPTS, signal: ctrl.signal }, () => {})).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  it('throws after exhausting retries', async () => {
    let calls = 0;
    const a = wrapStream(async () => {
      calls += 1;
      throw transient();
    });
    await expect(a.chatStream!(OPTS, () => {})).rejects.toBeInstanceOf(ChatHttpError);
    expect(calls).toBe(1 + DEFAULT_MAX_RETRIES);
  });

  it('leaves chatStream undefined when the adapter has none', () => {
    const a = withChatRetry(dispatcherFrom(async () => RESULT));
    expect(a.chatStream).toBeUndefined();
  });
});
