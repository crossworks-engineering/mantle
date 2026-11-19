/**
 * The provider is the cap (./provider-wait.ts): which answers are a "not
 * now" (and nothing else is), the gaps a waiting job is tried again after,
 * and the short wait inside a read of many calls that pays nothing twice.
 */
import { describe, expect, it } from 'vitest';
import { ProviderHttpError } from './provider-error';
import {
  callThroughWaits,
  PROVIDER_WAIT_MAX_GAP_MS,
  ProviderWaitError,
  providerWaitDelayMs,
  providerWaitOf,
  providerWaitPaid,
  providerWaitProgressed,
  tooLargeForLimit,
  type ProviderWait,
} from './provider-wait';

const http = (status: number, body = '', retryAfterMs?: number) =>
  new ProviderHttpError({ provider: 'openrouter', status, body, retryAfterMs });

describe('providerWaitOf', () => {
  it('429 is a rate limit, with the Retry-After it asked for', () => {
    expect(providerWaitOf(http(429, 'slow down', 30_000))).toEqual({
      reason: 'rate_limit',
      status: 429,
      retryAfterMs: 30_000,
    });
  });

  it('402, and a 429 or 403 that says no credits, is the quota', () => {
    expect(providerWaitOf(http(402))?.reason).toBe('quota');
    expect(providerWaitOf(http(429, '{"error":"insufficient_quota"}'))?.reason).toBe('quota');
    expect(providerWaitOf(http(403, 'Insufficient credits'))?.reason).toBe('quota');
  });

  it('503 and 529 are a busy provider', () => {
    expect(providerWaitOf(http(503))).toMatchObject({ reason: 'overloaded', status: 503 });
    expect(providerWaitOf(http(529, 'overloaded_error'))).toMatchObject({
      reason: 'overloaded',
      status: 529,
    });
  });

  it('a refusal of the content, a 500, a bad key or a timeout is no wait', () => {
    expect(providerWaitOf(http(400, 'invalid image'))).toBeNull();
    expect(providerWaitOf(http(400, 'flagged by moderation'))).toBeNull();
    expect(providerWaitOf(http(500))).toBeNull();
    expect(providerWaitOf(http(502))).toBeNull();
    expect(providerWaitOf(http(401))).toBeNull();
    expect(providerWaitOf(http(404, 'model not found'))).toBeNull();
    expect(providerWaitOf(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBeNull();
    expect(providerWaitOf(new Error('our own bug'))).toBeNull();
    expect(providerWaitOf(null)).toBeNull();
  });

  it('reads the cause below a wrapper (the translator, the extractor)', () => {
    const wrapped = new Error('The model provider answered with an error.', { cause: http(429) });
    expect(providerWaitOf(wrapped)?.reason).toBe('rate_limit');
    const twice = new Error('extract failed', { cause: wrapped });
    expect(providerWaitOf(twice)?.reason).toBe('rate_limit');
  });

  it('a ProviderWaitError carries its wait, also under a wrapper', () => {
    const err = new ProviderWaitError({ reason: 'quota', status: 402 }, 'vision');
    expect(providerWaitOf(err)).toEqual({ reason: 'quota', status: 402 });
    expect(providerWaitOf(new Error('x', { cause: err }))?.reason).toBe('quota');
    expect(err.message).toContain('no credit');
  });
});

describe('a 429 that no wait can pass', () => {
  it('a request larger than the limit itself is a refusal, not a wait', () => {
    const tooLarge = http(
      429,
      'Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 52000.',
    );
    expect(providerWaitOf(tooLarge)).toBeNull();
    expect(tooLargeForLimit('Limit 30,000, Requested 52,000')).toBe(true);
  });

  it('a plain rate limit that names its numbers still waits', () => {
    const plain = http(
      429,
      'Rate limit reached on tokens per min (TPM): Limit 30000, Used 29000, Requested 1500.',
    );
    expect(providerWaitOf(plain)?.reason).toBe('rate_limit');
    expect(tooLargeForLimit('Limit 30000, Used 29000, Requested 1500')).toBe(false);
  });
});

describe('a wait after paid calls', () => {
  it('says so, also under a wrapper', () => {
    const paid = new ProviderWaitError({ reason: 'rate_limit' }, 'vision', { paid: true });
    expect(providerWaitPaid(paid)).toBe(true);
    expect(providerWaitPaid(new Error('x', { cause: paid }))).toBe(true);
    expect(providerWaitPaid(new ProviderWaitError({ reason: 'rate_limit' }, 'vision'))).toBe(false);
    expect(providerWaitPaid(http(429))).toBe(false);
  });

  it('says a try that kept new work, also under a wrapper', () => {
    const kept = new ProviderWaitError({ reason: 'rate_limit' }, 'scan_reader', {
      paid: true,
      progressed: true,
    });
    expect(providerWaitProgressed(kept)).toBe(true);
    expect(providerWaitProgressed(new Error('x', { cause: kept }))).toBe(true);
    expect(providerWaitProgressed(new ProviderWaitError({ reason: 'quota' }, 'vision'))).toBe(
      false,
    );
    expect(providerWaitProgressed(http(429))).toBe(false);
  });
});

describe('providerWaitDelayMs', () => {
  it('1, 2, 4 ... minutes, then every hour, for as long as it waits', () => {
    expect(providerWaitDelayMs(0)).toBe(60_000);
    expect(providerWaitDelayMs(1)).toBe(120_000);
    expect(providerWaitDelayMs(5)).toBe(32 * 60_000);
    expect(providerWaitDelayMs(6)).toBe(PROVIDER_WAIT_MAX_GAP_MS);
    expect(providerWaitDelayMs(500)).toBe(PROVIDER_WAIT_MAX_GAP_MS);
  });

  it('a longer Retry-After is honoured, up to six hours; a shorter one is not', () => {
    expect(providerWaitDelayMs(0, { reason: 'rate_limit', retryAfterMs: 10 * 60_000 })).toBe(
      10 * 60_000,
    );
    expect(providerWaitDelayMs(0, { reason: 'rate_limit', retryAfterMs: 5_000 })).toBe(60_000);
    expect(providerWaitDelayMs(0, { reason: 'rate_limit', retryAfterMs: 48 * 3_600_000 })).toBe(
      6 * 3_600_000,
    );
  });
});

describe('callThroughWaits', () => {
  type A = { text: string; wait?: ProviderWait };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  it('a short rate limit: waits, asks the SAME again, and goes on', async () => {
    sleeps.length = 0;
    const answers: A[] = [{ text: '', wait: { reason: 'rate_limit' } }, { text: 'page 3' }];
    let calls = 0;
    const out = await callThroughWaits(
      async () => answers[calls++]!,
      (a) => a.wait,
      { pauses: [10, 20], sleep },
    );
    expect(out).toEqual({ text: 'page 3' });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([10]);
  });

  it('no credit is not waited for here: the answer goes back at once', async () => {
    sleeps.length = 0;
    let calls = 0;
    const out = await callThroughWaits(
      async () => {
        calls++;
        return { text: '', wait: { reason: 'quota' as const } };
      },
      (a) => a.wait,
      { pauses: [10, 20], sleep },
    );
    expect(out.wait?.reason).toBe('quota');
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('still busy after the pauses: the last answer, with its wait', async () => {
    sleeps.length = 0;
    let calls = 0;
    const out = await callThroughWaits<A>(
      async () => {
        calls++;
        return { text: '', wait: { reason: 'overloaded' } };
      },
      (a) => a.wait,
      { pauses: [10, 20], sleep },
    );
    expect(out.wait?.reason).toBe('overloaded');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it('a Retry-After longer than the pause is honoured, at most twice the pause', async () => {
    sleeps.length = 0;
    let calls = 0;
    await callThroughWaits<A>(
      async () =>
        calls++ === 0
          ? { text: '', wait: { reason: 'rate_limit', retryAfterMs: 999 } }
          : { text: 'ok' },
      (a) => a.wait,
      { pauses: [100], sleep },
    );
    expect(sleeps).toEqual([200]);
  });
});
