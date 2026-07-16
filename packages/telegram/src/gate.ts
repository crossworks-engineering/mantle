import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db, telegramChats, type TelegramAccount } from '@mantle/db';
import type { GateResult, InboundMessage } from './types';

const PAIRING_TTL_MS = 60 * 60 * 1000; // 1h
const PAIRING_MAX_REPLIES = 2;
const PAIRING_MAX_PENDING_PER_ACCOUNT = 3;

/**
 * Decide what to do with an inbound message based on the chat's allowlist
 * state. Mutates `telegram_chats` to record pairing attempts.
 *
 * The chat row is upserted on the way through so we always have a record
 * to attach pairing state to — even denied chats benefit from the
 * pairing_replies counter (used to stop replying after N attempts).
 */
export async function gate(account: TelegramAccount, message: InboundMessage): Promise<GateResult> {
  // Telegram groups aren't supported in v1; ignore them silently.
  if (message.chatType !== 'private') return { action: 'drop' };

  const chat = await upsertChat(account, message);

  if (chat.allowlistStatus === 'allowed') return { action: 'deliver' };
  if (chat.allowlistStatus === 'denied') return { action: 'drop' };

  // pending — issue or reissue a pairing code
  const now = Date.now();
  const expiresAtTime = chat.pairingExpiresAt ? chat.pairingExpiresAt.getTime() : 0;
  const codeStillValid = chat.pairingCode && expiresAtTime > now;

  if (codeStillValid) {
    if (chat.pairingReplies >= PAIRING_MAX_REPLIES) return { action: 'drop' };
    await db
      .update(telegramChats)
      .set({
        pairingReplies: chat.pairingReplies + 1,
        updatedAt: new Date(),
      })
      .where(eq(telegramChats.id, chat.id));
    return { action: 'pair', code: chat.pairingCode!, isResend: true };
  }

  // Generate a new code, but cap pending pairings per account so a flood
  // from many fake senders can't blot out a real one.
  const pendingCount = await countPendingForAccount(account.id);
  if (pendingCount >= PAIRING_MAX_PENDING_PER_ACCOUNT) return { action: 'drop' };

  const code = randomBytes(3).toString('hex'); // 6 hex chars
  await db
    .update(telegramChats)
    .set({
      pairingCode: code,
      pairingExpiresAt: new Date(now + PAIRING_TTL_MS),
      pairingReplies: 1,
      updatedAt: new Date(),
    })
    .where(eq(telegramChats.id, chat.id));
  return { action: 'pair', code, isResend: false };
}

async function upsertChat(account: TelegramAccount, message: InboundMessage) {
  const existing = await db
    .select()
    .from(telegramChats)
    .where(
      and(
        eq(telegramChats.accountId, account.id),
        eq(telegramChats.telegramChatId, message.chatId),
      ),
    )
    .limit(1);

  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(telegramChats)
    .values({
      accountId: account.id,
      userId: account.userId,
      telegramChatId: message.chatId,
      chatType: message.chatType,
      title: message.chatTitle,
      username: message.chatUsername,
      allowlistStatus: 'pending',
    })
    .returning();
  return inserted[0]!;
}

async function countPendingForAccount(accountId: string): Promise<number> {
  const rows = await db
    .select({ id: telegramChats.id })
    .from(telegramChats)
    .where(
      and(eq(telegramChats.accountId, accountId), eq(telegramChats.allowlistStatus, 'pending')),
    );
  return rows.length;
}
