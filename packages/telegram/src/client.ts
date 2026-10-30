import { Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import { TELEGRAM_POLICY_OFF_MESSAGE, telegramAllowed } from '@mantle/config';
import { open } from '@mantle/crypto';
import { channels, db, type TelegramAccount } from '@mantle/db';
import { installTelegramRetry } from './retry';

/**
 * Cache one `Bot` instance per account so we share HTTP keepalive across
 * outbound calls and the polling loop. Bot instances are stateless beyond
 * their token, so re-creating them is cheap, but caching avoids burning a
 * fresh TLS handshake on every reply.
 *
 * The bot token lives in the account's `channel` (`channels.credentials_enc`,
 * AAD = channel id) since the comms-channels cleanup (docs/comms-channels.md
 * §5) — `telegram_accounts.bot_token_enc` is gone. `botFor` is async because it
 * resolves the channel credential on a cache miss.
 */
const cache = new Map<string, Bot>();

/** Decrypt the bot token from the account's linked channel. */
async function tokenForAccount(account: TelegramAccount): Promise<string> {
  if (!account.channelId) {
    throw new Error(
      `telegram account ${account.id} (@${account.botUsername}) has no channel_id — cannot resolve its token`,
    );
  }
  const [channel] = await db
    .select({ id: channels.id, credentialsEnc: channels.credentialsEnc })
    .from(channels)
    .where(eq(channels.id, account.channelId))
    .limit(1);
  if (!channel) {
    throw new Error(
      `no channel ${account.channelId} for telegram account ${account.id} — token unavailable`,
    );
  }
  return open(channel.credentialsEnc, channel.id);
}

/** Thrown by botFor while the box policy switches Telegram off. */
export class TelegramPolicyOffError extends Error {
  constructor() {
    super(TELEGRAM_POLICY_OFF_MESSAGE);
    this.name = 'TelegramPolicyOffError';
  }
}

/** The one Bot API transport: every send, edit, poll and file read gets its
 *  Bot here. While the box policy switches Telegram off
 *  (MANTLE_POLICY_TELEGRAM=off, docs/policy.md) it refuses, so nothing
 *  reaches the Telegram API from any path; the rows stay. */
export async function botFor(account: TelegramAccount): Promise<Bot> {
  if (!telegramAllowed()) throw new TelegramPolicyOffError();
  const cached = cache.get(account.id);
  if (cached) return cached;
  const token = await tokenForAccount(account);
  const bot = new Bot(token);
  // 429 handling belongs at the TRANSPORT, not at each call site. It first
  // landed around one call — the text-chunk send in outbound.ts — which left
  // eleven others (sendPhoto, sendVoice, editMessageText, setMessageReaction,
  // answerCallbackQuery, sendChatAction, getFile …) to fail the turn on a rate
  // limit they could have waited out. A grammY transformer sits under every
  // Bot API call this instance makes, including ones grammY issues itself, so
  // a new call site is covered by construction. (2026-09-03 audit.)
  installTelegramRetry(bot);
  cache.set(account.id, bot);
  return bot;
}

/** Clears the cached Bot for an account (call after token rotation). */
export function evictBot(accountId: string): void {
  cache.delete(accountId);
}
