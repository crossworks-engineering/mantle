/**
 * Builtins: telegram_send.
 *
 * Split out of builtins.ts on 2026-09-02 (audit, bloat B6) with behaviour
 * unchanged; builtins.ts assembles BUILTIN_TOOLS from these groups.
 */

import { and, eq } from 'drizzle-orm';
import { db, telegramChats } from '@mantle/db';
import { type BuiltinToolDef } from './types';
import { str, strOpt, boolOpt as bool } from './coerce';
import { accountForChat, sendMessage } from '@mantle/telegram';
import { errorMessage } from '@mantle/std';

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
    // Verify allowlist on this owner.
    const [chat] = await db
      .select({ status: telegramChats.allowlistStatus })
      .from(telegramChats)
      .where(and(eq(telegramChats.userId, ctx.ownerId), eq(telegramChats.telegramChatId, chatId)))
      .limit(1);
    if (!chat || chat.status !== 'allowed') {
      return { ok: false, error: `chat ${chatId} is not allowlisted` };
    }
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

// ─── export the catalog ───────────────────────────────────────────────────

// ─── agent delegation ─────────────────────────────────────────────────────

/** Send a Telegram message from the responder's own bot. */
export const TELEGRAM_TOOLS: readonly BuiltinToolDef[] = [telegram_send];
