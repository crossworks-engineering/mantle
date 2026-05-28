import { GrammyError } from 'grammy';
import type { Update } from 'grammy/types';
import { and, eq } from 'drizzle-orm';
import {
  db,
  nodes,
  telegramAccounts,
  telegramChats,
  telegramMessages,
  type TelegramAccount,
  type TelegramAttachment,
} from '@mantle/db';
import { botFor } from './client';
import { gate } from './gate';
import type { InboundMessage } from './types';

/**
 * One pass of getUpdates for a single account. Long-polls up to `timeout`
 * seconds, ingests every passing message, and advances the cursor.
 *
 * The worker calls this in a loop; one pass per (job, tick) so pg-boss
 * can serialise concurrent ticks via singletonKey.
 */
export async function pollOnce(account: TelegramAccount, timeoutSec = 25): Promise<{
  updatesReceived: number;
  delivered: number;
}> {
  const bot = botFor(account);
  const offset = account.lastUpdateOffset || 0;

  let updates: Update[];
  try {
    updates = await bot.api.getUpdates({
      offset: offset === 0 ? undefined : offset,
      timeout: timeoutSec,
      allowed_updates: ['message'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(telegramAccounts)
      .set({
        lastPollAt: new Date(),
        lastPollError: msg,
        updatedAt: new Date(),
      })
      .where(eq(telegramAccounts.id, account.id));
    // 409 Conflict means another instance is polling this token. Surface
    // it loudly via the error column but don't crash the worker.
    if (err instanceof GrammyError && err.error_code === 409) {
      console.error(`[telegram-sync] 409 Conflict for @${account.botUsername} — another poller is active`);
    }
    throw err;
  }

  let delivered = 0;
  let highestUpdateId = offset > 0 ? offset - 1 : 0;
  for (const update of updates) {
    if (update.update_id > highestUpdateId) highestUpdateId = update.update_id;
    const inbound = normalise(update);
    if (!inbound) continue;
    const result = await gate(account, inbound);
    if (result.action === 'deliver') {
      const ok = await persist(account, inbound);
      if (ok) delivered++;
    } else if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending approval' : 'Approval required';
      await bot.api
        .sendMessage(
          inbound.chatId,
          `${lead}. The owner can approve this chat in Mantle: Settings → Agents → ` +
            `this bot's responder → Telegram bot.\n\n(Pairing code: ${result.code})`,
        )
        .catch((e) => console.error(`[telegram-sync] pair-reply failed: ${e}`));
    }
  }

  await db
    .update(telegramAccounts)
    .set({
      lastUpdateOffset: highestUpdateId + 1,
      lastPollAt: new Date(),
      lastPollError: null,
      updatedAt: new Date(),
    })
    .where(eq(telegramAccounts.id, account.id));

  return { updatesReceived: updates.length, delivered };
}

/**
 * Map a Telegram Update to our internal InboundMessage shape. Returns
 * null for updates we don't care about (edits, channel posts, etc.).
 */
function normalise(update: Update): InboundMessage | null {
  const msg = update.message;
  if (!msg) return null;
  const chat = msg.chat;
  if (chat.type !== 'private' && chat.type !== 'group' && chat.type !== 'supergroup') {
    return null;
  }
  const from = msg.from;
  if (!from) return null;

  const attachments: TelegramAttachment[] = [];
  let text = msg.text ?? msg.caption ?? '';

  if (msg.photo && msg.photo.length > 0) {
    // Largest size last.
    const best = msg.photo[msg.photo.length - 1]!;
    attachments.push({ kind: 'photo', file_id: best.file_id, size: best.file_size });
    if (!text) text = '(photo)';
  } else if (msg.document) {
    attachments.push({
      kind: 'document',
      file_id: msg.document.file_id,
      name: msg.document.file_name,
      mime: msg.document.mime_type,
      size: msg.document.file_size,
    });
    if (!text) text = `(document: ${msg.document.file_name ?? 'file'})`;
  } else if (msg.voice) {
    attachments.push({
      kind: 'voice',
      file_id: msg.voice.file_id,
      mime: msg.voice.mime_type,
      size: msg.voice.file_size,
    });
    if (!text) text = '(voice message)';
  } else if (msg.audio) {
    attachments.push({
      kind: 'audio',
      file_id: msg.audio.file_id,
      name: msg.audio.file_name,
      mime: msg.audio.mime_type,
      size: msg.audio.file_size,
    });
    if (!text) text = '(audio)';
  } else if (msg.video) {
    attachments.push({
      kind: 'video',
      file_id: msg.video.file_id,
      name: msg.video.file_name,
      mime: msg.video.mime_type,
      size: msg.video.file_size,
    });
    if (!text) text = '(video)';
  } else if (msg.sticker) {
    attachments.push({
      kind: 'sticker',
      file_id: msg.sticker.file_id,
      size: msg.sticker.file_size,
    });
    if (!text) text = `(sticker${msg.sticker.emoji ? ' ' + msg.sticker.emoji : ''})`;
  }

  const chatTitle = chat.type === 'private'
    ? [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username
    : 'title' in chat ? chat.title : undefined;
  const chatUsername = 'username' in chat ? chat.username : undefined;
  const fromName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username;

  return {
    updateId: update.update_id,
    messageId: String(msg.message_id),
    chatId: String(chat.id),
    chatType: chat.type,
    chatTitle: chatTitle || undefined,
    chatUsername: chatUsername || undefined,
    fromUserId: String(from.id),
    fromUsername: from.username,
    fromName: fromName || undefined,
    text,
    sentAt: new Date(msg.date * 1000),
    attachments,
  };
}

async function persist(account: TelegramAccount, inbound: InboundMessage): Promise<boolean> {
  // We need the chat row to point at; gate() already upserted it.
  const [chat] = await db
    .select()
    .from(telegramChats)
    .where(
      and(
        eq(telegramChats.accountId, account.id),
        eq(telegramChats.telegramChatId, inbound.chatId),
      ),
    )
    .limit(1);
  if (!chat) {
    console.error(`[telegram-sync] missing chat row for ${account.id}/${inbound.chatId}`);
    return false;
  }

  // Build the nodes title — keep it short, the body lives on telegram_messages.text
  const titlePreview = inbound.text.length > 80 ? inbound.text.slice(0, 77) + '…' : inbound.text;
  const title = `tg: ${inbound.fromName ?? inbound.fromUsername ?? inbound.fromUserId} — ${titlePreview}`;
  const path = `${account.branchPath}.${inbound.chatId}`.replace(/[^a-z0-9._]/gi, '_').toLowerCase();

  return await db.transaction(async (tx) => {
    const [node] = await tx
      .insert(nodes)
      .values({
        ownerId: account.userId,
        type: 'telegram_message',
        title,
        path,
        data: {
          chat_id: inbound.chatId,
          message_id: inbound.messageId,
          from_user_id: inbound.fromUserId,
          from_username: inbound.fromUsername,
          from_name: inbound.fromName,
          text: inbound.text,
          sent_at: inbound.sentAt.toISOString(),
          attachments: inbound.attachments,
        },
      })
      .returning();

    try {
      await tx.insert(telegramMessages).values({
        nodeId: node!.id,
        accountId: account.id,
        chatId: chat.id,
        telegramMessageId: inbound.messageId,
        telegramUpdateId: inbound.updateId,
        fromUserId: inbound.fromUserId,
        fromUsername: inbound.fromUsername,
        fromName: inbound.fromName,
        text: inbound.text,
        sentAt: inbound.sentAt,
        attachments: inbound.attachments,
      });
    } catch (err: any) {
      // Unique constraint on (account_id, telegram_update_id) — dup, swallow.
      if (err?.code === '23505') {
        await tx.delete(nodes).where(eq(nodes.id, node!.id));
        return false;
      }
      throw err;
    }

    await tx
      .update(telegramChats)
      .set({ lastMessageAt: inbound.sentAt, updatedAt: new Date() })
      .where(eq(telegramChats.id, chat.id));
    return true;
  });
}
