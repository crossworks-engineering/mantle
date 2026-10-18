/**
 * Builtins: telegram_send plus each user's Telegram operator surface.
 *
 * Split out of builtins.ts on 2026-09-02 (audit, bloat B6) with behaviour
 * unchanged; builtins.ts assembles BUILTIN_TOOLS from these groups.
 *
 * The operator tools below (pending / react / edit / mark_processed / pair)
 * were hand-written on the MCP side until tier 3 of the same audit. They are
 * `mcpOnly`: the caller is a USER working their own Telegram chats by hand,
 * and `telegram_pair` in particular moves the allowlist, the trust boundary
 * that decides who may talk to the brain at all, so no agent is granted
 * them. The in-brain path into Telegram stays the runtime's own turn handler.
 *
 * Telegram per paired user (workspaces W7d): a paired chat belongs to one
 * login (telegram_chats.login_id). Every tool here acts only on chats paired
 * to the caller's own login (the anchor: its own chats, no longer every
 * chat), and telegram_pair pairs a chat to the caller and nobody else.
 */

import { and, asc, eq } from 'drizzle-orm';
import {
  systemWork,
  currentTurnStamp,
  db,
  scopeLeftForSystem,
  telegramChats,
  telegramMessages,
  type TelegramAccount,
} from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import { type BuiltinToolDef, type ToolHandlerContext } from './types';
import { ownerSurfaceLoginId } from './surface';
import { str, strOpt, numOpt as num, boolOpt as bool } from './coerce';
import {
  accountById,
  editMessage,
  pairChatWithCode,
  pairedChatOf,
  previewChatPairing,
  reactToMessage,
  sendMessage,
  type PairedChat,
} from '@mantle/telegram';
import { errorMessage } from '@mantle/std';
import { CS } from './client-sourced-rule';

/**
 * The bot and chat rows the Telegram tools need, read on the system pool by
 * the named reason 'login-telegram' (the workspace role reads none of them).
 * Every tool here is an Admin-area tool that runs whole on the system pool
 * (`systemWhole`: dispatch runs it inside the 'admin-area' exit), so these
 * reads never run in a scope: systemWork refuses one (A6b: no exit).
 */
function telegramSystemWork<T>(fn: () => Promise<T>): Promise<T> {
  return systemWork(fn, 'login-telegram');
}

/**
 * The login this call acts for (workspaces W7d): the login its surface
 * names (a web or Telegram chat, an MCP connection, an API key), else the
 * login of the scope it runs in (or the scope its system-pool work left),
 * else the turn's stamp, else the
 * anchor's own stdio MCP (an owner surface that names no login). Null when
 * none is known: every tool here then refuses. Never read from model
 * arguments.
 */
export function telegramCallerLogin(ctx: ToolHandlerContext): string | null {
  const named = ownerSurfaceLoginId(ctx.surface);
  if (named) return named;
  const scope = currentWorkspaceScope() ?? scopeLeftForSystem();
  if (scope?.loginId) return scope.loginId;
  const stamped = currentTurnStamp()?.loginId;
  if (stamped) return stamped;
  const s = ctx.surface as { kind?: string; via?: string; loginId?: unknown } | undefined;
  if (s?.kind === 'owner' && s.via === 'mcp' && !s.loginId) return ctx.ownerId;
  return null;
}

/** The refusal when no login is known for the call. */
export const TELEGRAM_NO_LOGIN_ERROR =
  'this call names no user, and a Telegram chat is worked only by the user it is paired to.';

/**
 * The outbound gate for a chat (W7d): it must be allowlisted AND paired to
 * the caller's own login. Returns the chat with the bot it is on, so the
 * send goes out on that bot (one Telegram chat id can sit on two bots).
 * Another user's chat answers like an unknown one: nothing about it leaks.
 */
async function ownAllowedChat(
  ctx: ToolHandlerContext,
  chatId: string,
): Promise<
  { ok: true; chat: PairedChat; account: TelegramAccount } | { ok: false; error: string }
> {
  const loginId = telegramCallerLogin(ctx);
  if (!loginId) return { ok: false, error: TELEGRAM_NO_LOGIN_ERROR };
  const chat = await pairedChatOf({ ownerId: ctx.ownerId, loginId, telegramChatId: chatId });
  if (!chat) {
    return {
      ok: false,
      error: `chat ${chatId} is not one of your paired chats: see yours with telegram_pending, or pair one with telegram_pair`,
    };
  }
  const account = await telegramSystemWork(() => accountById(chat.accountId));
  if (!account || !account.enabled) {
    return { ok: false, error: 'no enabled telegram bot for this chat' };
  }
  return { ok: true, chat, account };
}

export const telegram_send: BuiltinToolDef = {
  slug: 'telegram_send',
  policy: {
    matrix: { none: 'names no item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'connectors', systemWhole: true },
    // A message out of the brain (A5 step 5).
    outside: { egress: true },
    peerRisky: true,
    clientSourced: CS.always(CS.OUTWARD),
  },
  name: 'Send a Telegram message',
  description:
    "Send a Telegram DM to one of the user's own paired chats. Use only when explicitly asked to message someone, never on the user's initiative without confirmation.",
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
    const gate = await ownAllowedChat(ctx, chatId);
    if (!gate.ok) return gate;
    try {
      const ids = await sendMessage(gate.account, chatId, text, {
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
  policy: {
    matrix: { none: 'a Telegram chat is not an item' },
    effect: 'read',
    spends: 'none',
    scope: { area: 'connectors', systemWhole: true },
    // Inbound messages from outside the brain: fenced as data (A5 step 5).
    outside: { untrusted: true },
    peerRisky: true,
  },
  mcpOnly: true,
  name: 'List unanswered Telegram DMs',
  description:
    'Unanswered Telegram DMs in your own paired chats, oldest first. Call after each turn (or via /loop) to see what needs a reply. Returns the row id (for mark_processed), telegram_message_id (for reply threading), chat_id, sender, text, and sent_at.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: "Telegram's numeric chat id (as string)" },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'cap the rows returned' },
    },
  },
  handler: async (input, ctx) => {
    const loginId = telegramCallerLogin(ctx);
    if (!loginId) return { ok: false, error: TELEGRAM_NO_LOGIN_ERROR };
    const chatId = strOpt(input.chat_id);
    // Scope rides on the chat: telegram_messages has no owner or login
    // column, so the join to telegram_chats (this brain, the caller's own
    // login, still allowed) is what keeps another user's queue out.
    const conds = [
      eq(telegramMessages.processed, false),
      eq(telegramChats.userId, ctx.ownerId),
      eq(telegramChats.loginId, loginId),
      eq(telegramChats.allowlistStatus, 'allowed'),
    ];
    if (chatId) conds.push(eq(telegramChats.telegramChatId, chatId));
    const rows = await telegramSystemWork(() =>
      db
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
        .limit(num(input.limit) ?? 20),
    );
    return { ok: true, output: rows };
  },
};

export const telegram_react: BuiltinToolDef = {
  slug: 'telegram_react',
  policy: {
    matrix: { none: 'a Telegram message is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'connectors', systemWhole: true },
    peerRisky: true,
    clientSourced: CS.free('a reaction on a message (MCP only)'),
  },
  mcpOnly: true,
  name: 'React to a Telegram message',
  description:
    'Add an emoji reaction to a Telegram message in one of your own paired chats. Telegram accepts only a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc).',
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
    const gate = await ownAllowedChat(ctx, chatId);
    if (!gate.ok) return gate;
    try {
      await reactToMessage(gate.account, chatId, messageId, emoji);
      return { ok: true, output: 'reacted' };
    } catch (err) {
      return { ok: false, error: `react failed: ${errorMessage(err)}` };
    }
  },
};

export const telegram_edit: BuiltinToolDef = {
  slug: 'telegram_edit',
  policy: {
    matrix: { none: 'a Telegram message is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'connectors', systemWhole: true },
    peerRisky: true,
    clientSourced: CS.always(CS.OUTWARD),
  },
  mcpOnly: true,
  name: 'Edit a sent Telegram message',
  description:
    'Edit a previously-sent Telegram message in one of your own paired chats, in place. Useful for progress updates. Edits do not trigger push notifications: send a new reply when a long task completes.',
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
    const gate = await ownAllowedChat(ctx, chatId);
    if (!gate.ok) return gate;
    try {
      await editMessage(gate.account, chatId, messageId, text, { markdown: bool(input.markdown) });
      return { ok: true, output: 'edited' };
    } catch (err) {
      return { ok: false, error: `edit failed: ${errorMessage(err)}` };
    }
  },
};

export const telegram_mark_processed: BuiltinToolDef = {
  slug: 'telegram_mark_processed',
  policy: {
    matrix: { none: 'a Telegram message is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'connectors', systemWhole: true },
    peerRisky: true,
    clientSourced: CS.free('marks an inbound message done (MCP only)'),
  },
  mcpOnly: true,
  name: 'Mark a Telegram message answered',
  description:
    'Mark a telegram message in one of your own paired chats as answered so it stops appearing in telegram_pending. Pass the row id from telegram_pending.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'the row id from telegram_pending' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const loginId = telegramCallerLogin(ctx);
    if (!loginId) return { ok: false, error: TELEGRAM_NO_LOGIN_ERROR };
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    // Scope rides on the chat, telegram_messages has no owner or login
    // column. Resolved first so the UPDATE cannot touch a row of another
    // user's chat: marking it processed means their assistant never
    // answers it, and nothing anywhere errors.
    const rows = await telegramSystemWork(async () => {
      const [owned] = await db
        .select({ id: telegramMessages.id })
        .from(telegramMessages)
        .innerJoin(telegramChats, eq(telegramMessages.chatId, telegramChats.id))
        .where(
          and(
            eq(telegramMessages.id, id),
            eq(telegramChats.userId, ctx.ownerId),
            eq(telegramChats.loginId, loginId),
          ),
        )
        .limit(1);
      if (!owned) return [];
      return db
        .update(telegramMessages)
        .set({ processed: true, processedAt: new Date() })
        .where(eq(telegramMessages.id, id))
        .returning({ id: telegramMessages.id });
    });
    if (rows.length === 0) {
      return {
        ok: false,
        error: 'no such message in your chats: take the id from telegram_pending',
      };
    }
    return { ok: true, output: 'marked processed' };
  },
};

export const telegram_pair: BuiltinToolDef = {
  slug: 'telegram_pair',
  policy: {
    matrix: { none: 'names no item' },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    peerRisky: true,
    clientSourced: CS.always('it gives a chat access to an agent (MCP only)'),
  },
  mcpOnly: true,
  name: 'Pair your Telegram chat',
  description:
    "Pair the Telegram chat that was sent this code to YOU (the signed-in user), never to anyone else, in two calls. Without `confirm` it pairs nothing and returns which chat (its @username or id), bot and assistant the code is for: show that to the user. Only once they say it is their own chat, call again with `confirm: true` and the `preview_token` it returned (required; it holds for ten minutes). Works only for a bot whose assistant is in a workspace you are a user of; the bot's assistant then answers the chat as you.",
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        pattern: '^[a-fA-F0-9]{6}$',
        description: 'the six-hex-digit pairing code the chat was given',
      },
      confirm: {
        type: 'boolean',
        default: false,
        description: 'true pairs the chat; leave it off first to see whose chat the code is for',
      },
      preview_token: {
        type: 'string',
        pattern: '^[a-f0-9]{32}$',
        description:
          'the token the preview call returned, required with confirm: the confirm then pairs that chat and no other',
      },
    },
    required: ['code'],
  },
  handler: async (input, ctx) => {
    // Only the user pairs their own chat (the owner's answer 1A, W7d): the
    // chat is paired to the login this call acts for, whoever that is. Two
    // steps (W7d fix round 1, M3): someone else's code shows whose chat it
    // is before it pairs anything.
    const loginId = telegramCallerLogin(ctx);
    if (!loginId) return { ok: false, error: TELEGRAM_NO_LOGIN_ERROR };
    const code = str(input.code);
    if (!/^[a-f0-9]{6}$/i.test(code)) return { ok: false, error: 'code must be six hex digits' };
    if (bool(input.confirm) !== true) {
      const p = await previewChatPairing({ ownerId: ctx.ownerId, loginId, code });
      if (!p.ok) return { ok: false, error: p.error };
      // The checked label only (noticeLabelOf), never the chat's free title
      // (W7d+e): the title is the chat owner's text, and a model reads this.
      const what = `Telegram ${p.preview.chat.label} (id ${p.preview.chat.telegramChatId}) on bot ${p.preview.bot.name}${p.preview.agentName ? `, answered by ${p.preview.agentName}` : ''}`;
      return {
        ok: true,
        output: p.already
          ? `${what} is already paired to you: nothing to do.`
          : `Nothing is paired yet. This code is for ${what}. Ask the user whether this is their own chat; only if it is, call telegram_pair again with confirm: true and preview_token: "${p.previewToken}".`,
      };
    }
    // A confirm needs the preview's token (W7d+e): the user saw whose chat
    // it is first.
    const token = strOpt(input.preview_token) ?? null;
    if (!token) {
      return {
        ok: false,
        error:
          'confirm needs preview_token: call telegram_pair with this code and no confirm first, show the user whose chat it is, then confirm with the preview_token it returns.',
      };
    }
    const r = await pairChatWithCode({ ownerId: ctx.ownerId, loginId, code, previewToken: token });
    if (!r.ok) return { ok: false, error: r.error };
    if (r.already) return { ok: true, output: 'already paired to you' };
    // Never the chat's free title (W7d+e): its owner chose it, and this
    // output is read by a model.
    return {
      ok: true,
      output: `paired ${r.chat.noticeLabel} to you`,
    };
  },
};

// ─── export the catalog ───────────────────────────────────────────────────

/** Send a Telegram message from the responder's own bot. */
export const TELEGRAM_TOOLS: readonly BuiltinToolDef[] = [telegram_send];

/** Each user's own Telegram chat controls: MCP-only, never granted. */
export const TELEGRAM_OPERATOR_TOOLS: readonly BuiltinToolDef[] = [
  telegram_pending,
  telegram_react,
  telegram_edit,
  telegram_mark_processed,
  telegram_pair,
];
