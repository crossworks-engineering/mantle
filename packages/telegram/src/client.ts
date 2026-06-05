import { Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import { open } from '@mantle/crypto';
import { channels, db, type TelegramAccount } from '@mantle/db';

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

export async function botFor(account: TelegramAccount): Promise<Bot> {
  const cached = cache.get(account.id);
  if (cached) return cached;
  const token = await tokenForAccount(account);
  const bot = new Bot(token);
  cache.set(account.id, bot);
  return bot;
}

/** Clears the cached Bot for an account (call after token rotation). */
export function evictBot(accountId: string): void {
  cache.delete(accountId);
}
