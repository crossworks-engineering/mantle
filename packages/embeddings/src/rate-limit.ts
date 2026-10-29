import { backoffMs, withRetry } from '@mantle/std';
import { classifyProviderError } from './provider-error';

/**
 * Rate-limit backoff for one embed request. The provider pool
 * (@mantle/voice provider-fetch.ts) runs parallel embed calls side by side,
 * so a burst (the extractor pool, a windows backfill) can meet a provider's
 * rate limit. A 429 waits and retries, at most {@link RATE_LIMIT_RETRIES}
 * times (2 s, 4 s, 8 s, 16 s, with jitter); anything else throws at once.
 * The loop is @mantle/std withRetry, with these numbers.
 *
 * A 429 that says the account has no credits (OpenAI's `insufficient_quota`)
 * is not a rate limit: no wait fixes it, so it throws at once too
 * (provider-error.ts).
 */
const RATE_LIMIT_RETRIES = 4;

/** True when an embed error is a 429 rate limit (the adapters put the status
 *  in the message). A quota 429 is an account problem, not a rate limit. */
export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return classifyProviderError(err)?.code === 'rate_limit';
}

export function withRateLimitBackoff<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  return withRetry(call, {
    retries: RATE_LIMIT_RETRIES,
    retryOn: (f) => isRateLimitError(f.error),
    delayMs: (retry) => backoffMs(retry - 1, { baseMs: 2_000, jitter: 'quarter' }),
    sleep,
  });
}
