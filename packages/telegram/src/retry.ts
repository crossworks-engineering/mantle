/**
 * Telegram rate limits (2026-09-02 audit, gap D5). Bot API answers a burst
 * with HTTP 429 and `parameters.retry_after` (seconds); before this nothing
 * in the package honoured it, so a long reply that tripped the per-chat limit
 * failed the turn mid-message (the Microsoft client had the equivalent for
 * Graph since v0.1xx). Wrap every outbound Bot API call: retry after the
 * server-stated wait (capped), a few times, then surface the error.
 */
import { GrammyError } from 'grammy';
import { sleep } from '@mantle/std';

const MAX_RETRIES = 3;
const RETRY_AFTER_CAP_MS = 30_000;

export function telegramRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof GrammyError) || err.error_code !== 429) return null;
  const secs = Number((err.parameters as { retry_after?: unknown } | undefined)?.retry_after);
  const ms = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 1_000;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

/** Run a Bot API call, waiting out 429s up to {@link MAX_RETRIES} times. */
export async function withTelegramRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const wait = telegramRetryAfterMs(err);
      if (wait == null || attempt >= MAX_RETRIES) throw err;
      console.warn(`[telegram] 429 — retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
      await sleep(wait);
    }
  }
}
