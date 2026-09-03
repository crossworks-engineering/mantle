import { describe, expect, it } from 'vitest';
import { Bot, GrammyError } from 'grammy';
import { installTelegramRetry, telegramRetryAfterMs, withTelegramRetry } from './retry';

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

describe('installTelegramRetry', () => {
  /** A bot whose transport is faked: the first `fail429` calls throw 429, the
   *  rest succeed. Records the methods that reached the transport. */
  function fakeBot(fail429: number) {
    const bot = new Bot('123:fake');
    // Install order matters: in grammY the LAST transformer installed is the
    // OUTERMOST, so this stand-in goes on first to take the place the real
    // network transport holds in production, and installTelegramRetry then
    // wraps it exactly as it wraps the real one.
    const attempts: string[] = [];
    let remaining = fail429;
    bot.api.config.use(async (_prev, method) => {
      attempts.push(method);
      if (remaining-- > 0) throw tooMany(0.01);
      return { ok: true, result: { message_id: 1 } } as never;
    });
    installTelegramRetry(bot);
    return { bot, attempts };
  }

  // Every Bot API call the package makes, not just the text send the retry
  // originally wrapped. If a new one appears in outbound.ts it is covered by
  // the transformer already — this list is what proves the seam, not the reach.
  it.each([
    ['sendMessage', (b: Bot) => b.api.sendMessage('1', 'hi')],
    ['sendPhoto', (b: Bot) => b.api.sendPhoto('1', 'file-id')],
    ['sendVoice', (b: Bot) => b.api.sendVoice('1', 'file-id')],
    ['editMessageText', (b: Bot) => b.api.editMessageText('1', 2, 'edited')],
    ['answerCallbackQuery', (b: Bot) => b.api.answerCallbackQuery('cb1')],
    ['setMessageReaction', (b: Bot) => b.api.setMessageReaction('1', 2, [])],
    ['sendChatAction', (b: Bot) => b.api.sendChatAction('1', 'typing')],
    ['getFile', (b: Bot) => b.api.getFile('file-id')],
  ])('waits out a 429 on %s', async (method, call) => {
    const { bot, attempts } = fakeBot(2);
    await call(bot);
    // Two refusals then the send: the call survived the rate limit instead of
    // failing the turn.
    expect(attempts).toEqual([method, method, method]);
  });

  it('gives up after the same budget as the bare wrapper, not a multiple of it', async () => {
    // The call sites must NOT wrap again on top of the transformer: nested
    // retries would turn 3 attempts into 9 against a rate limit.
    const { bot, attempts } = fakeBot(99);
    await expect(bot.api.sendMessage('1', 'hi')).rejects.toBeInstanceOf(GrammyError);
    expect(attempts).toHaveLength(4); // the first try plus MAX_RETRIES
  });
});
