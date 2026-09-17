/**
 * Builtins: telegram_send plus the owner's Telegram operator surface.
 *
 * Split out of builtins.ts on 2026-09-02 (audit, bloat B6) with behaviour
 * unchanged; builtins.ts assembles BUILTIN_TOOLS from these groups.
 *
 * The operator tools below (pending / react / edit / mark_processed / pair)
 * were hand-written on the MCP side until tier 3 of the same audit. They are
 * `mcpOnly`: the caller is the OWNER working their own inbox by hand, and
 * `telegram_pair` in particular moves the allowlist — the trust boundary that
 * decides who may talk to the brain at all — so no agent is granted them. The
 * in-brain path into Telegram stays the runtime's own turn handler.
 */

import { and, asc, eq } from 'drizzle-orm';
import {
  agents,
  channels,
  db,
  telegramAccounts,
  telegramChats,
  telegramMessages,
} from '@mantle/db';
import { type BuiltinToolDef } from './types';
import { str, strOpt, numOpt as num, boolOpt as bool } from './coerce';
import { accountForChat, editMessage, reactToMessage, sendMessage } from '@mantle/telegram';
import { errorMessage } from '@mantle/std';

/**
 * The outbound gate for a chat: the caller must OWN it and it must be
 * allowlisted.
 *
 * `accountForChat` reads as though it scopes and does not — its parameter is
 * `_chatId` and it returns the first enabled account on the box — so every
 * tool that reaches the Telegram API has to carry this check itself.
 * `telegram_send` always did; `telegram_react` and `telegram_edit` did not,
 * and would act on any chat id handed to them, allowlisted or not, owned or
 * not. One helper now, so the next outbound tool cannot forget it.
 */
async function allowlistedChat(
  ownerId: string,
  chatId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [chat] = await db
    .select({ status: telegramChats.allowlistStatus })
    .from(telegramChats)
    .where(and(eq(telegramChats.userId, ownerId), eq(telegramChats.telegramChatId, chatId)))
    .limit(1);
  if (!chat || chat.status !== 'allowed') {
    return { ok: false, error: `chat ${chatId} is not allowlisted` };
  }
  return { ok: true };
}

export const telegram_send: BuiltinToolDef = {
  slug: 'telegram_send',
  name: 'Send a Telegram message',
  description:
    "Send a Telegram DM to one of the user's allowlisted chats. Use only when explicitly asked to message someone — never on the user's initiative without confirmation.",
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: "Telegram's numeric chat id (as string)" },
      text: {
        type: 'string',
        minLength: 1,
        description: 'the message body to send — plain text unless `markdown` is set',
      },
      reply_to: { type: 'string', description: 'optional telegram_message_id to thread under' },
      markdown: {
        type: 'boolean',
        default: false,
        description: 'render the text as Telegram MarkdownV2 instead of plain text',
      },
    },
    required: ['chat_id', 'text'],
  },
  handler: async (input, ctx) => {
    const chatId = str(input.chat_id);
    const text = str(input.text);
    if (!chatId || !text) return { ok: false, error: 'chat_id + text required' };
    const account = await accountForChat(chatId);
    if (!account) return { ok: false, error: 'no enabled telegram account for this chat' };
    const gate = await allowlistedChat(ctx.ownerId, chatId);
    if (!gate.ok) return gate;
    try {
      const ids = await sendMessage(account, chatId, text, {
        replyTo: strOpt(input.reply_to),
        markdown: bool(input.markdown),
      });
      ctx.step?.setOutput({ messageIds: ids });
      return { ok: true, output: { messageIds: ids } };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const telegram_pending: BuiltinToolDef = {
  slug: 'telegram_pending',
  mcpOnly: true,
  readOnly: true,
  name: 'List unanswered Telegram DMs',
  description:
    'Unanswered Telegram DMs, oldest first. Call after each turn (or via /loop) to see what needs a reply. Returns the row id (for mark_processed), telegram_message_id (for reply threading), chat_id, sender, text, and sent_at.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: "Telegram's numeric chat id (as string)" },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'cap the rows returned' },
    },
  },
  handler: async (input, ctx) => {
    const chatId = strOpt(input.chat_id);
    // Owner scope rides on the chat: telegram_messages has no owner column, so
    // the join to telegram_chats.user_id is what keeps one owner's pending
    // queue out of another's. See builtins-read-scope.test.ts.
    const conds = [eq(telegramMessages.processed, false), eq(telegramChats.userId, ctx.ownerId)];
    if (chatId) {
      // chat_id is the *Telegram* chat id; resolve to our internal pk first.
      const [chat] = await db
        .select({ id: telegramChats.id })
        .from(telegramChats)
        .where(and(eq(telegramChats.userId, ctx.ownerId), eq(telegramChats.telegramChatId, chatId)))
        .limit(1);
      if (!chat) return { ok: true, output: [] };
      conds.push(eq(telegramMessages.chatId, chat.id));
    }
    const rows = await db
      .select({
        id: telegramMessages.id,
        telegram_message_id: telegramMessages.telegramMessageId,
        chat_id: telegramChats.telegramChatId,
        from_user_id: telegramMessages.fromUserId,
        from_username: telegramMessages.fromUsername,
        from_name: telegramMessages.fromName,
        text: telegramMessages.text,
        sent_at: telegramMessages.sentAt,
        attachments: telegramMessages.attachments,
      })
      .from(telegramMessages)
      .innerJoin(telegramChats, eq(telegramMessages.chatId, telegramChats.id))
      .where(and(...conds))
      .orderBy(asc(telegramMessages.sentAt))
      .limit(num(input.limit) ?? 20);
    return { ok: true, output: rows };
  },
};

export const telegram_react: BuiltinToolDef = {
  slug: 'telegram_react',
  mcpOnly: true,
  name: 'React to a Telegram message',
  description:
    'Add an emoji reaction to a Telegram message. Telegram accepts only a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc).',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: "Telegram's numeric chat id (as string)" },
      message_id: { type: 'string', description: 'the telegram_message_id to react to' },
      emoji: { type: 'string', description: "one emoji from Telegram's reaction whitelist" },
    },
    required: ['chat_id', 'message_id', 'emoji'],
  },
  handler: async (input, ctx) => {
    const chatId = str(input.chat_id);
    const messageId = str(input.message_id);
    const emoji = str(input.emoji);
    if (!chatId || !messageId || !emoji) {
      return { ok: false, error: 'chat_id + message_id + emoji required' };
    }
    const gate = await allowlistedChat(ctx.ownerId, chatId);
    if (!gate.ok) return gate;
    const account = await accountForChat(chatId);
    if (!account) return { ok: false, error: 'no enabled telegram account' };
    try {
      await reactToMessage(account, chatId, messageId, emoji);
      return { ok: true, output: 'reacted' };
    } catch (err) {
      return { ok: false, error: `react failed: ${errorMessage(err)}` };
    }
  },
};

export const telegram_edit: BuiltinToolDef = {
  slug: 'telegram_edit',
  mcpOnly: true,
  name: 'Edit a sent Telegram message',
  description:
    'Edit a previously-sent Telegram message in place. Useful for progress updates. Edits do not trigger push notifications — send a new reply when a long task completes.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: "Telegram's numeric chat id (as string)" },
      message_id: { type: 'string', description: 'the telegram_message_id to edit' },
      text: { type: 'string', minLength: 1, description: 'the replacement body' },
      markdown: {
        type: 'boolean',
        default: false,
        description: 'render the text as Telegram MarkdownV2 instead of plain text',
      },
    },
    required: ['chat_id', 'message_id', 'text'],
  },
  handler: async (input, ctx) => {
    const chatId = str(input.chat_id);
    const messageId = str(input.message_id);
    const text = str(input.text);
    if (!chatId || !messageId || !text) {
      return { ok: false, error: 'chat_id + message_id + text required' };
    }
    const gate = await allowlistedChat(ctx.ownerId, chatId);
    if (!gate.ok) return gate;
    const account = await accountForChat(chatId);
    if (!account) return { ok: false, error: 'no enabled telegram account' };
    try {
      await editMessage(account, chatId, messageId, text, { markdown: bool(input.markdown) });
      return { ok: true, output: 'edited' };
    } catch (err) {
      return { ok: false, error: `edit failed: ${errorMessage(err)}` };
    }
  },
};

export const telegram_mark_processed: BuiltinToolDef = {
  slug: 'telegram_mark_processed',
  mcpOnly: true,
  name: 'Mark a Telegram message answered',
  description:
    'Mark a telegram message as answered so it stops appearing in telegram_pending. Pass the row id from telegram_pending.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'the row id from telegram_pending' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    // Owner scope rides on the chat, telegram_messages has no owner column.
    // Resolved first so the UPDATE cannot touch a row the caller does not own:
    // marking someone else's inbound message processed means their assistant
    // never answers it, and nothing anywhere errors.
    const [owned] = await db
      .select({ id: telegramMessages.id })
      .from(telegramMessages)
      .innerJoin(telegramChats, eq(telegramMessages.chatId, telegramChats.id))
      .where(and(eq(telegramMessages.id, id), eq(telegramChats.userId, ctx.ownerId)))
      .limit(1);
    if (!owned) return { ok: false, error: 'no such message' };
    const rows = await db
      .update(telegramMessages)
      .set({ processed: true, processedAt: new Date() })
      .where(eq(telegramMessages.id, id))
      .returning({ id: telegramMessages.id });
    if (rows.length === 0) return { ok: false, error: 'no such message' };
    return { ok: true, output: 'marked processed' };
  },
};

export const telegram_pair: BuiltinToolDef = {
  slug: 'telegram_pair',
  mcpOnly: true,
  name: 'Approve a Telegram pairing code',
  description:
    'Approve a pending Telegram pairing code. The chat gets allowlisted and a confirmation DM is sent.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        pattern: '^[a-fA-F0-9]{6}$',
        description: 'the six-hex-digit pairing code the chat was given',
      },
    },
    required: ['code'],
  },
  handler: async (input, ctx) => {
    const code = str(input.code);
    if (!/^[a-f0-9]{6}$/i.test(code)) return { ok: false, error: 'code must be six hex digits' };
    const [chat] = await db
      .select()
      .from(telegramChats)
      .where(and(eq(telegramChats.pairingCode, code), eq(telegramChats.userId, ctx.ownerId)))
      .limit(1);
    if (!chat) return { ok: false, error: 'no pending pairing with that code' };
    if (chat.allowlistStatus === 'allowed') return { ok: true, output: 'already paired' };
    if (chat.pairingExpiresAt && chat.pairingExpiresAt.getTime() < Date.now()) {
      return { ok: false, error: 'code expired — ask them to DM again' };
    }
    await db
      .update(telegramChats)
      .set({
        allowlistStatus: 'allowed',
        pairingCode: null,
        pairingExpiresAt: null,
        pairingReplies: 0,
        updatedAt: new Date(),
      })
      .where(eq(telegramChats.id, chat.id));

    const [account] = await db
      .select()
      .from(telegramAccounts)
      .where(eq(telegramAccounts.id, chat.accountId))
      .limit(1);
    if (account) {
      let name = 'your assistant';
      if (account.channelId) {
        const [agentRow] = await db
          .select({ name: agents.name })
          .from(agents)
          .innerJoin(channels, eq(channels.agentId, agents.id))
          .where(eq(channels.id, account.channelId))
          .limit(1);
        if (agentRow?.name) name = agentRow.name;
      }
      try {
        await sendMessage(account, chat.telegramChatId, `Paired! Say hi to ${name}.`);
      } catch (err) {
        // The chat is paired in the DB; the confirmation DM is best-effort.
        console.error('[telegram_pair] confirm DM failed:', err);
      }
    }
    return {
      ok: true,
      output: `paired chat ${chat.telegramChatId} (${chat.title ?? chat.username ?? 'unnamed'})`,
    };
  },
};

// ─── export the catalog ───────────────────────────────────────────────────

/** Send a Telegram message from the responder's own bot. */
export const TELEGRAM_TOOLS: readonly BuiltinToolDef[] = [telegram_send];

/** The owner's own Telegram inbox controls — MCP-only, never granted. */
export const TELEGRAM_OPERATOR_TOOLS: readonly BuiltinToolDef[] = [
  telegram_pending,
  telegram_react,
  telegram_edit,
  telegram_mark_processed,
  telegram_pair,
];
