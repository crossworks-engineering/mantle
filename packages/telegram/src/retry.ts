/**
 * Telegram rate limits (2026-09-02 audit, gap D5). Bot API answers a burst
 * with HTTP 429 and `parameters.retry_after` (seconds); before this nothing
 * in the package honoured it, so a long reply that tripped the per-chat limit
 * failed the turn mid-message (the Microsoft client had the equivalent for
 * Graph since v0.1xx). Wrap every outbound Bot API call: retry after the
 * server-stated wait (capped), a few times, then surface the error.
 */
import { GrammyError, type Bot } from 'grammy';
import { parseRetryAfterMs, withRetry } from '@mantle/std';

const MAX_RETRIES = 3;
const RETRY_AFTER_CAP_MS = 30_000;

export function telegramRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof GrammyError) || err.error_code !== 429) return null;
  const raw = (err.parameters as { retry_after?: unknown } | undefined)?.retry_after;
  const parsed =
    typeof raw === 'number' || typeof raw === 'string' ? parseRetryAfterMs(raw) : undefined;
  const ms = parsed !== undefined && parsed > 0 ? parsed : 1_000;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

/** Run a Bot API call, waiting out 429s up to {@link MAX_RETRIES} times
 *  (@mantle/std withRetry). */
export function withTelegramRetry<T>(call: () => Promise<T>): Promise<T> {
  return withRetry(call, {
    retries: MAX_RETRIES,
    retryOn: (f) => telegramRetryAfterMs(f.error) !== null,
    delayMs: (_retry, f) => telegramRetryAfterMs(f.error),
    onRetry: ({ retry, delayMs }) => {
      console.warn(`[telegram] 429, retry ${retry}/${MAX_RETRIES} in ${delayMs}ms`);
    },
  });
}

/**
 * Install the 429 wait on EVERY Bot API call this instance makes.
 *
 * The retry first landed around ONE call site — the text-chunk send in
 * outbound.ts — which left sendPhoto, sendVoice, editMessageText,
 * setMessageReaction, answerCallbackQuery, sendChatAction and getFile to fail
 * the turn on a rate limit they could have waited out (2026-09-03 audit). A
 * grammY api transformer sits under all of them, and under the calls grammY
 * makes on its own behalf, so a new call site is covered by construction.
 *
 * Install it ONCE per Bot, and do not also wrap a call site: nesting would
 * multiply the attempt budget against a rate limit rather than respecting it.
 *
 * Install it at construction, before any other transformer. grammY runs the
 * LAST-installed transformer outermost, so installing first puts this closest
 * to the network — it retries the HTTP call itself, and anything added later
 * sees one logical call rather than each attempt.
 */
export function installTelegramRetry(bot: Bot): void {
  bot.api.config.use((prev, method, payload, signal) =>
    withTelegramRetry(() => prev(method, payload, signal)),
  );
}
