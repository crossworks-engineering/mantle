import { describe, expect, it } from 'vitest';
import { GrammyError } from 'grammy';
import { telegramRetryAfterMs, withTelegramRetry } from './retry';

function tooMany(retryAfter?: number): GrammyError {
  return new GrammyError(
    'Too Many Requests',
    {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 1',
      parameters: retryAfter != null ? { retry_after: retryAfter } : {},
    },
    'sendMessage',
    {},
  );
}

describe('telegram 429 handling', () => {
  it('reads retry_after seconds and caps it', () => {
    expect(telegramRetryAfterMs(tooMany(2))).toBe(2000);
    expect(telegramRetryAfterMs(tooMany(999))).toBe(30_000);
    expect(telegramRetryAfterMs(tooMany())).toBe(1000);
    expect(telegramRetryAfterMs(new Error('x'))).toBeNull();
  });
  it('retries a 429 then succeeds', async () => {
    let calls = 0;
    const r = await withTelegramRetry(async () => {
      calls += 1;
      if (calls < 3) throw tooMany(0.01);
      return 'sent';
    });
    expect(r).toBe('sent');
    expect(calls).toBe(3);
  });
  it('rethrows anything that is not a 429', async () => {
    await expect(
      withTelegramRetry(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
