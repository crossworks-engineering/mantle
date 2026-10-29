import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TimeoutError,
  backoffMs,
  formatMs,
  parseRetryAfterMs,
  timeoutSignal,
  withRetry,
  withTimeout,
} from './http';
import { NET_TIMEOUTS, PROVIDER_TIMEOUTS } from './timeouts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('withTimeout', () => {
  it('settles with the promise when it wins', async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, 'x')).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error('no')), 1_000, 'x')).rejects.toThrow('no');
  });

  it('rejects with a named TimeoutError when the deadline wins', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 30 * 60_000, 'nightly-sweep');
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const err = await caught;
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).name).toBe('TimeoutError');
    expect((err as Error).message).toBe('nightly-sweep timed out after 30 min');
  });

  it('clears its timer on settle', async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve(1), 5_000, 'x');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('formatMs', () => {
  it('reads as minutes, seconds or milliseconds', () => {
    expect(formatMs(1_800_000)).toBe('30 min');
    expect(formatMs(3_000)).toBe('3 s');
    expect(formatMs(1_500)).toBe('1500 ms');
  });
});

describe('timeoutSignal', () => {
  it('aborts with a TimeoutError after the deadline', async () => {
    const s = timeoutSignal(5);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.aborted).toBe(true);
    expect((s.reason as Error).name).toBe('TimeoutError');
  });

  it("aborts at once with the caller's signal", () => {
    const stop = new AbortController();
    const s = timeoutSignal(60_000, stop.signal);
    stop.abort(new Error('stop'));
    expect(s.aborted).toBe(true);
    expect((s.reason as Error).message).toBe('stop');
  });
});

describe('backoffMs', () => {
  it('doubles from the base, caps before jitter, and jitters as asked', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect([0, 1, 2, 3].map((n) => backoffMs(n, { baseMs: 1_000 }))).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
    expect(backoffMs(10, { baseMs: 500, maxMs: 8_000, jitter: 'full' })).toBe(4_000);
    expect(backoffMs(1, { baseMs: 2_000, jitter: 'quarter' })).toBe(4_500);
    expect(backoffMs(2, { baseMs: 1, factor: 3 })).toBe(9);
  });
});

describe('withRetry', () => {
  const noSleep = vi.fn(async (_ms: number) => {});

  it('retries a named error up to the budget, waiting delayMs, then throws the last', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let n = 0;
    const p = withRetry(
      async () => {
        n += 1;
        throw new Error(`e${n}`);
      },
      { retries: 2, retryOn: () => true, delayMs: (r) => r * 100, sleep },
    );
    await expect(p).rejects.toThrow('e3');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it('never retries a thrown error unless retryOn names it', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw new Error('x');
        },
        { retries: 5, isFailure: () => true, delayMs: () => 0, sleep: noSleep },
      ),
    ).rejects.toThrow('x');
    expect(n).toBe(1);
  });

  it('retries a failing value, and returns the last one when the budget is spent', async () => {
    let n = 0;
    const out = await withRetry(async () => ++n, {
      retries: 3,
      isFailure: (v) => v < 10,
      delayMs: () => 0,
      sleep: noSleep,
    });
    expect(out).toBe(4);
  });

  it('gives up where delayMs says null (a deadline), returning the value', async () => {
    let n = 0;
    const out = await withRetry(async () => ++n, {
      retries: Infinity,
      isFailure: () => true,
      delayMs: (r) => (r < 3 ? 0 : null),
      sleep: noSleep,
    });
    expect(out).toBe(3);
  });

  it('calls onRetry before each wait with the retry number and delay', async () => {
    const seen: string[] = [];
    let n = 0;
    await withRetry(
      async () => {
        n += 1;
        if (n < 3) throw new Error('t');
        return 'ok';
      },
      {
        retries: 5,
        retryOn: () => true,
        delayMs: (r) => r,
        onRetry: ({ retry, retries, delayMs }) => {
          seen.push(`${retry}/${retries}@${delayMs}`);
        },
        sleep: noSleep,
      },
    );
    expect(seen).toEqual(['1/5@1', '2/5@2']);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads seconds, an HTTP date, a bare value or a number, never negative', () => {
    const now = Date.parse('2026-10-15T00:00:00Z');
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '2' }), now)).toBe(2_000);
    expect(parseRetryAfterMs('Thu, 15 Oct 2026 00:00:03 GMT', now)).toBe(3_000);
    expect(parseRetryAfterMs(1.5)).toBe(1_500);
    expect(parseRetryAfterMs(-1)).toBe(0);
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs({})).toBeUndefined();
    expect(parseRetryAfterMs({ get: () => null })).toBeUndefined();
  });

  it('prefers retry-after-ms (Azure OpenAI, OpenAI) over the seconds header', () => {
    const both = new Headers({ 'retry-after-ms': '1250', 'retry-after': '2' });
    expect(parseRetryAfterMs(both)).toBe(1_250);
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '400' }))).toBe(400);
    // An unreadable ms value falls back to the seconds header.
    const junk = new Headers({ 'retry-after-ms': 'soon', 'retry-after': '3' });
    expect(parseRetryAfterMs(junk)).toBe(3_000);
    const blank = { get: (n: string) => (n === 'retry-after-ms' ? '   ' : '3') };
    expect(parseRetryAfterMs(blank)).toBe(3_000);
  });
});

describe('the timeout tables', () => {
  it('keep every value a positive whole number of ms', () => {
    for (const [k, v] of Object.entries({ ...PROVIDER_TIMEOUTS, ...NET_TIMEOUTS })) {
      expect(Number.isInteger(v) && v > 0, k).toBe(true);
    }
  });
});
