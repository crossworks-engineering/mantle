import { GrammyError } from 'grammy';
import type { Update } from 'grammy/types';
import { and, eq, sql } from 'drizzle-orm';
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
import { answerCallback, editApprovalCard, parseApprovalCallback } from './outbound';
import type { InboundMessage, PollHandlers } from './types';

/**
 * One pass of getUpdates for a single account. Long-polls up to `timeout`
 * seconds, ingests every passing message, and advances the cursor.
 *
 * The worker calls this in a loop; one pass per (job, tick) so pg-boss
 * can serialise concurrent ticks via singletonKey.
 */
export async function pollOnce(
  account: TelegramAccount,
  timeoutSec = 25,
  handlers: PollHandlers = {},
): Promise<{
  updatesReceived: number;
  delivered: number;
}> {
  const bot = await botFor(account);
  const offset = account.lastUpdateOffset || 0;

  let updates: Update[];
  try {
    updates = await bot.api.getUpdates({
      offset: offset === 0 ? undefined : offset,
      timeout: timeoutSec,
      // `callback_query` carries inline-button taps from approval cards
      // (sendApprovalCard). Without it here Telegram never delivers them.
      allowed_updates: ['message', 'callback_query'],
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
  // Track the highest update_id actually RECEIVED this batch. We deliberately do
  // NOT seed this from the prior offset: if the bot's update-id stream resets
  // (the token is repointed at a different bot, whose ids are lower), seeding
  // from the old offset would pin nextOffset above the new stream forever —
  // Telegram keeps returning the same low-id update and the cursor never moves
  // (the infinite "1 update, 0 delivered" wedge). Acking with max(received)+1
  // lets the cursor follow the real stream in either direction; any redelivered
  // row is caught by persist()'s onConflictDoNothing, so moving the cursor
  // "backward" is harmless.
  let maxReceived = -1;
  for (const update of updates) {
    if (update.update_id > maxReceived) maxReceived = update.update_id;
    // Inline-button taps (approval cards) come as callback_query, not
    // message. Handle + ack them here so the cursor still advances past
    // them; they never go through gate()/persist().
    if (update.callback_query) {
      await handleCallback(account, update.callback_query, handlers);
      continue;
    }
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

  // Empty batch (long-poll timeout) → keep the cursor where it is; otherwise ack
  // through the highest id we actually received this pass.
  const nextOffset = maxReceived >= 0 ? maxReceived + 1 : offset;
  await db
    .update(telegramAccounts)
    .set({
      lastUpdateOffset: nextOffset,
      lastPollAt: new Date(),
      lastPollError: null,
      updatedAt: new Date(),
    })
    .where(eq(telegramAccounts.id, account.id));

  return { updatesReceived: updates.length, delivered };
}

/**
 * Resolve an approval-card button tap. Authorisation is deliberately
 * derived from the *chat row*, never from the callback's `from` id: a tap
 * is honoured only if it arrives in a chat that is already `allowed` on
 * this account, and it acts solely on that chat's owner's queue. The
 * actual approve/reject is delegated to the injected handler so this
 * package never imports @mantle/tools (cycle avoidance).
 *
 * Soft-fails throughout — a callback we can't process still gets an
 * answerCallbackQuery so the user's button stops spinning.
 */
async function handleCallback(
  account: TelegramAccount,
  cq: NonNullable<Update['callback_query']>,
  handlers: PollHandlers,
): Promise<void> {
  const parsed = parseApprovalCallback(cq.data);
  const chatId = cq.message?.chat?.id != null ? String(cq.message.chat.id) : null;
  if (!parsed || !chatId) {
    await answerCallback(account, cq.id, 'Unrecognised action.');
    return;
  }
  if (!handlers.onApproval) {
    await answerCallback(account, cq.id, 'Approvals are not available right now.');
    return;
  }

  const [chat] = await db
    .select({ status: telegramChats.allowlistStatus, userId: telegramChats.userId })
    .from(telegramChats)
    .where(
      and(
        eq(telegramChats.accountId, account.id),
        eq(telegramChats.telegramChatId, chatId),
      ),
    )
    .limit(1);
  if (!chat || chat.status !== 'allowed') {
    await answerCallback(account, cq.id, 'Not authorised.');
    return;
  }

  let outcome: { ok: boolean; text: string };
  try {
    outcome = await handlers.onApproval({
      ownerId: chat.userId,
      decision: parsed.decision,
      pendingId: parsed.pendingId,
    });
  } catch (err) {
    console.error('[telegram-sync] approval handler threw:', err);
    outcome = { ok: false, text: 'Something went wrong applying that.' };
  }

  await answerCallback(account, cq.id, outcome.text);
  // Rewrite the card so the buttons clear and the chat shows the outcome.
  if (cq.message) {
    await editApprovalCard(
      account,
      chatId,
      cq.message.message_id,
      'text' in cq.message && typeof cq.message.text === 'string' ? cq.message.text : '🔐 Approval',
      outcome.text,
    );
  }
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

    // Idempotent on (account_id, telegram_update_id). A re-delivered update —
    // common when two pollers briefly overlap on restart, or any Telegram
    // at-least-once redelivery — must be SKIPPED, not raised. Raising 23505
    // inside the transaction aborts it (so a catch's node-cleanup can never
    // run — Postgres rejects every command until rollback) AND escapes pollOnce
    // before it advances last_update_offset, wedging the account into a
    // re-fetch/throw loop on that update. onConflictDoNothing avoids the error
    // entirely; an empty `returning` is the "was a duplicate" signal.
    const ins = await tx
      .insert(telegramMessages)
      .values({
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
      })
      // The arbiter is a PARTIAL unique index (`… where telegram_update_id is
      // not null`, migration 0012 — outbound rows have a null update_id). Postgres
      // only infers a partial index when the ON CONFLICT clause repeats its
      // predicate; without this `where` it raises 42P10 "no unique or exclusion
      // constraint matching the ON CONFLICT specification".
      .onConflictDoNothing({
        target: [telegramMessages.accountId, telegramMessages.telegramUpdateId],
        where: sql`${telegramMessages.telegramUpdateId} is not null`,
      })
      .returning({ id: telegramMessages.id });

    if (ins.length === 0) {
      // Duplicate — undo the node we optimistically inserted, report not-delivered.
      await tx.delete(nodes).where(eq(nodes.id, node!.id));
      return false;
    }

    await tx
      .update(telegramChats)
      .set({ lastMessageAt: inbound.sentAt, updatedAt: new Date() })
      .where(eq(telegramChats.id, chat.id));
    return true;
  });
}
