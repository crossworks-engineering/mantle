/**
 * Rate-limit backoff for one embed request. The provider pool
 * (@mantle/voice provider-fetch.ts) lets parallel embed calls run side by side
 * where Node's built-in fetch had sent them one at a time, so a burst (the
 * extractor pool, a windows backfill) can now meet a provider's rate limit.
 * A 429 waits and retries, at most {@link RATE_LIMIT_RETRIES} times
 * (2 s, 4 s, 8 s, 16 s, with jitter); anything else throws at once, as before.
 */
const RATE_LIMIT_RETRIES = 4;

/** True when an embed error is a 429 (the adapters put the status in the message). */
export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') return status === 429;
  return /(?:failed|error)\D{0,20}?\b429\b/i.test(err.message);
}

export async function withRateLimitBackoff<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= RATE_LIMIT_RETRIES || !isRateLimitError(err)) throw err;
      const base = 2_000 * 2 ** attempt;
      await sleep(base + Math.floor(Math.random() * base * 0.25));
    }
  }
}
