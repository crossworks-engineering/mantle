import { describe, expect, it, vi } from 'vitest';
import { isRateLimitError, withRateLimitBackoff } from './rate-limit';

const rateLimited = () =>
  new Error('OpenRouter embeddings failed: 429 Too Many Requests — slow down');

describe('isRateLimitError', () => {
  it('reads a 429 from the adapter message or a status field', () => {
    expect(isRateLimitError(rateLimited())).toBe(true);
    expect(isRateLimitError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(
      isRateLimitError(new Error('OpenAI embeddings failed: 400 Bad Request — 429 tokens')),
    ).toBe(false);
    expect(isRateLimitError(new Error('OpenRouter embeddings failed: 500 Internal'))).toBe(false);
    expect(isRateLimitError('429')).toBe(false);
  });
});

describe('withRateLimitBackoff', () => {
  it('waits and retries a 429, then returns the result', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const out = await withRateLimitBackoff(async () => {
      if (++calls < 3) throw rateLimited();
      return 'ok';
    }, sleep);
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const waits = sleep.mock.calls.map((c) => (c as unknown as [number])[0]);
    expect(waits[0]).toBeGreaterThanOrEqual(2_000);
    expect(waits[1]).toBeGreaterThanOrEqual(4_000);
  });

  it('gives up after four retries (bounded, never a storm)', async () => {
    const sleep = vi.fn(async () => {});
    const call = vi.fn(async () => {
      throw rateLimited();
    });
    await expect(withRateLimitBackoff(call, sleep)).rejects.toThrow(/429/);
    expect(call).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it('throws any other error at once', async () => {
    const sleep = vi.fn(async () => {});
    const call = vi.fn(async () => {
      throw new Error('OpenRouter embeddings failed: 401 Unauthorized');
    });
    await expect(withRateLimitBackoff(call, sleep)).rejects.toThrow(/401/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
