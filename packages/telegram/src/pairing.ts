/**
 * Pairing, blocking and unpairing a Telegram chat (workspaces W7d; the
 * owner's answer 1A of 2026-10-11).
 *
 * Only the user pairs their own chat: the chat's code (the bot sent it to
 * the person on Telegram) entered while signed in (the web, the phone, or
 * their own MCP client) pairs the chat to THAT login, and only when the
 * login is a user of the workspace of the bot's assistant. A Moderator of
 * that workspace and an Admin user with the users area may block or unpair
 * any chat of the bot, never pair one to someone else. A user may unpair or
 * block their own chat.
 *
 * Used by the telegram_pair tool (@mantle/tools) and the web routes
 * (server/web lib/agent-telegram.ts), so the two never differ.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  agents,
  asSystem,
  assistantMessages,
  authUsers,
  channels,
  db,
  telegramAccounts,
  telegramChats,
  type TelegramChat,
} from '@mantle/db';
import { chatLoginRefusal, loginModeratesBot, TELEGRAM_NOT_A_USER_CODE } from './chat-login';
import { sendMessage } from './outbound';

/**
 * This file's one system door (arch A6): the pairing rows (a chat's code, its
 * login) are read and written on the system pool by the named reason
 * 'login-telegram'. Every read and write below goes through it.
 */
function telegramLoginSystem<T>(fn: () => Promise<T>): Promise<T> {
  return asSystem(fn, 'login-telegram');
}

/** A refusal: the reply text, and a code a screen can tell apart. */
export type PairingRefusal = { ok: false; error: string; code: PairingRefusalCode };
export type PairingRefusalCode =
  | 'no_such_code'
  | 'code_expired'
  | 'not_a_workspace_user'
  | 'no_assistant'
  | 'paired_to_another'
  | 'too_many_attempts'
  | 'preview_mismatch'
  | 'not_found'
  | 'not_allowed';

/** The chat a pairing or a block acted on. `label` may be the chat's free
 *  title (for a screen, as plain text); `noticeLabel` is the one text an
 *  assistant may read (noticeLabelOf). */
export type PairedChatSummary = {
  id: string;
  telegramChatId: string;
  label: string;
  noticeLabel: string;
  agentName: string | null;
};

const FAILED_LIMIT = 10;
const FAILED_WINDOW_MS = 10 * 60 * 1000;
const failedPairs = new Map<string, number[]>();

/** Failed code tries per login in the window: a code is six hex digits, so a
 *  signed-in login may not guess at other people's pending chats. */
function tooManyFailures(loginId: string, now: number): boolean {
  const recent = (failedPairs.get(loginId) ?? []).filter((t) => now - t < FAILED_WINDOW_MS);
  failedPairs.set(loginId, recent);
  return recent.length >= FAILED_LIMIT;
}

function noteFailure(loginId: string, now: number): void {
  failedPairs.set(loginId, [...(failedPairs.get(loginId) ?? []), now]);
}

/** Test seam: forget the failed tries. */
export function resetPairingAttempts(): void {
  failedPairs.clear();
}

function labelOf(chat: { title: string | null; username: string | null; telegramChatId: string }) {
  return chat.title ?? (chat.username ? `@${chat.username}` : chat.telegramChatId);
}

/** The assistant a bot belongs to (its id and name), or null. */
async function botAgent(accountId: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: agents.id, name: agents.name })
    .from(telegramAccounts)
    .innerJoin(channels, eq(channels.id, telegramAccounts.channelId))
    .innerJoin(agents, eq(agents.id, channels.agentId))
    .where(eq(telegramAccounts.id, accountId))
    .limit(1);
  return row ?? null;
}

/** The name of the assistant a bot belongs to, or null. */
async function botAgentName(accountId: string): Promise<string | null> {
  return (await botAgent(accountId))?.name ?? null;
}

/** What a pairing code is for, shown BEFORE it pairs (W7d fix round 1, M3):
 *  the Telegram chat, the bot and its assistant, so a user handed someone
 *  else's code sees whose chat it is before it becomes theirs.
 *
 *  `chat.label` is the only chat text an assistant reads (noticeLabelOf: a
 *  checked @username, else the chat id; W7d+e). `chat.title` is the chat's
 *  free title, capped at PREVIEW_TITLE_MAX characters, for a screen to show
 *  as plain text and never for a model: its owner chose it, so it may carry
 *  instructions. */
export type PairingPreview = {
  chat: { label: string; title: string | null; telegramChatId: string };
  bot: { name: string };
  agentName: string | null;
};

/** The longest chat title a preview carries (W7d+e). */
export const PREVIEW_TITLE_MAX = 64;

function previewTitleOf(chat: Pick<TelegramChat, 'title'>): string | null {
  // Control characters become spaces: the title is one plain line.
  const chars = Array.from(chat.title ?? '').map((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp < 0x20 || cp === 0x7f ? ' ' : c;
  });
  const title = chars.join('').trim();
  return title ? Array.from(title).slice(0, PREVIEW_TITLE_MAX).join('').trim() : null;
}

/** How long a preview's token may confirm (W7d+e). */
export const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;

/** The MAC of a preview token: keyed by the chat's row id, which nothing
 *  shows before the chat is paired, over the Telegram chat, the login, the
 *  code and the token's expiry (seconds). */
function previewMacOf(
  chat: Pick<TelegramChat, 'id' | 'telegramChatId'>,
  loginId: string,
  code: string,
  expSec: number,
): string {
  return createHmac('sha256', `telegram-pair:${chat.id}`)
    .update(`${chat.telegramChatId}:${loginId.toLowerCase()}:${code}:${expSec}`)
    .digest('hex')
    .slice(0, 24);
}

/** Binds a confirm to the preview it follows (W7d fix round 1, M3; W7d+e):
 *  the chat the code named then, for this login and this code, for
 *  PREVIEW_TOKEN_TTL_MS. 32 hex: the expiry (8) and the MAC (24). Not the
 *  secret (the code is); a confirm without it, after it expires, or whose
 *  code now names another chat is refused (preview_mismatch). */
function previewTokenOf(
  chat: Pick<TelegramChat, 'id' | 'telegramChatId'>,
  loginId: string,
  code: string,
  now: number,
): string {
  const expSec = Math.floor((now + PREVIEW_TOKEN_TTL_MS) / 1000);
  return expSec.toString(16).padStart(8, '0') + previewMacOf(chat, loginId, code, expSec);
}

/** Whether `token` is a live preview token for this chat, login and code. */
function previewTokenValid(
  token: string | null | undefined,
  chat: Pick<TelegramChat, 'id' | 'telegramChatId'>,
  loginId: string,
  code: string,
  now: number,
): boolean {
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return false;
  const expSec = Number.parseInt(token.slice(0, 8), 16);
  const nowSec = Math.floor(now / 1000);
  if (expSec < nowSec || expSec > nowSec + PREVIEW_TOKEN_TTL_MS / 1000 + 60) return false;
  const want = Buffer.from(previewMacOf(chat, loginId, code, expSec), 'utf8');
  const got = Buffer.from(token.slice(8), 'utf8');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A Telegram username is safe to repeat in a thread an assistant reads; a
 *  chat's title is free text its owner chose, so the id stands in for it. */
function noticeLabelOf(chat: Pick<TelegramChat, 'username' | 'telegramChatId'>) {
  return chat.username && /^[A-Za-z0-9_]{3,32}$/.test(chat.username)
    ? `@${chat.username}`
    : `chat ${chat.telegramChatId}`;
}

/** Refusal text for a login that is not a user of the bot's workspace. */
export const NOT_A_WORKSPACE_USER_ERROR =
  "you are not a user of this bot's assistant's workspace, so you cannot pair a chat to it. Ask a Moderator of that workspace to add you first.";

const NO_SUCH_CODE = {
  ok: false as const,
  error: 'no pending pairing with that code: send the bot a new message for a fresh one.',
  code: 'no_such_code' as const,
};

type PairTarget =
  | { ok: true; already: true; chat: TelegramChat; summary: PairedChatSummary }
  | { ok: true; already: false; chat: TelegramChat; summary: PairedChatSummary };

/**
 * The chat `code` names, checked for `loginId` (shared by the preview and the
 * pairing, so the two never differ): pending with a live code, on this brain,
 * on a bot whose assistant's workspace the login is a user of. Runs on the
 * system pool (the caller's asSystem). A wrong code counts a failure.
 */
async function pairingTarget(args: {
  ownerId: string;
  loginId: string;
  code: string;
  now: number;
}): Promise<PairTarget | PairingRefusal> {
  const { ownerId, loginId, code, now } = args;
  const [chat] = await db
    .select()
    .from(telegramChats)
    .where(and(eq(telegramChats.pairingCode, code), eq(telegramChats.userId, ownerId)))
    .limit(1);
  if (!chat) {
    noteFailure(loginId, now);
    return NO_SUCH_CODE;
  }
  // A login that no longer exists pairs nothing (no login carries a role
  // that grants or refuses this since workspaces W8a: chatLoginRefusal
  // below asks its workspaces).
  const [who] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  if (!who) {
    return {
      ok: false as const,
      error: 'this login cannot pair a Telegram chat.',
      code: 'not_allowed' as const,
    };
  }
  const refusal = await chatLoginRefusal({
    ownerId,
    loginId,
    accountId: chat.accountId,
    responderAgentId: chat.responderAgentId,
  });
  if (refusal === 'no_assistant') {
    return {
      ok: false as const,
      error: 'no assistant answers this bot now, so the chat cannot be paired.',
      code: 'no_assistant' as const,
    };
  }
  if (refusal) {
    return {
      ok: false as const,
      error: NOT_A_WORKSPACE_USER_ERROR,
      code: TELEGRAM_NOT_A_USER_CODE,
    };
  }
  const summary: PairedChatSummary = {
    id: chat.id,
    telegramChatId: chat.telegramChatId,
    label: labelOf(chat),
    noticeLabel: noticeLabelOf(chat),
    agentName: await botAgentName(chat.accountId),
  };
  if (chat.allowlistStatus === 'allowed') {
    if (chat.loginId && chat.loginId.toLowerCase() === loginId.toLowerCase()) {
      return { ok: true as const, already: true as const, chat, summary };
    }
    return {
      ok: false as const,
      error: 'this chat is paired to another user. Ask a Moderator to unpair it first.',
      code: 'paired_to_another' as const,
    };
  }
  if (chat.allowlistStatus !== 'pending') {
    noteFailure(loginId, now);
    return NO_SUCH_CODE;
  }
  if (chat.pairingExpiresAt && chat.pairingExpiresAt.getTime() < now) {
    return {
      ok: false as const,
      error: 'that code expired: send the bot a new message for a fresh one.',
      code: 'code_expired' as const,
    };
  }
  return { ok: true as const, already: false as const, chat, summary };
}

const TOO_MANY: PairingRefusal = {
  ok: false,
  error: 'too many wrong pairing codes: wait ten minutes, then try the newest code again.',
  code: 'too_many_attempts',
};

/**
 * What `code` would pair, without pairing it (step one of two, W7d fix round
 * 1, M3): the chat, the bot and its assistant, and a token the confirm may
 * carry back so it pairs that chat and no other. The same checks as the
 * pairing; a wrong code counts a failure here too.
 */
export async function previewChatPairing(args: {
  ownerId: string;
  loginId: string;
  code: string;
}): Promise<
  { ok: true; already: boolean; preview: PairingPreview; previewToken: string } | PairingRefusal
> {
  const { ownerId, loginId } = args;
  const now = Date.now();
  if (tooManyFailures(loginId, now)) return TOO_MANY;
  const code = args.code.trim().toLowerCase();
  return telegramLoginSystem(async () => {
    const t = await pairingTarget({ ownerId, loginId, code, now });
    if (!t.ok) return t;
    const [account] = await db
      .select({ botUsername: telegramAccounts.botUsername })
      .from(telegramAccounts)
      .where(eq(telegramAccounts.id, t.chat.accountId))
      .limit(1);
    return {
      ok: true as const,
      already: t.already,
      preview: {
        chat: {
          label: noticeLabelOf(t.chat),
          title: previewTitleOf(t.chat),
          telegramChatId: t.chat.telegramChatId,
        },
        bot: { name: account ? `@${account.botUsername}` : 'the bot' },
        agentName: t.summary.agentName,
      },
      previewToken: previewTokenOf(t.chat, loginId, code, now),
    };
  });
}

/**
 * Pair the chat holding `code` to `loginId` (the caller, never anyone
 * else; step two of two, after previewChatPairing). The chat must be pending
 * with a live code, on this brain, on a bot whose assistant's workspace the
 * login is a user of. `previewToken` is required (W7d+e): the token of a
 * preview of this code by this login, under PREVIEW_TOKEN_TTL_MS old, whose
 * chat the code still names; else preview_mismatch. A chat already paired
 * to this login answers `already` (no change); one paired to another login
 * is refused. Then the login is
 * told in the app (a notice in its own thread with the bot's assistant,
 * naming the chat and the bot), and a best-effort confirmation DM follows.
 */
export async function pairChatWithCode(args: {
  ownerId: string;
  loginId: string;
  code: string;
  previewToken?: string | null;
}): Promise<{ ok: true; already: boolean; chat: PairedChatSummary } | PairingRefusal> {
  const { ownerId, loginId } = args;
  const now = Date.now();
  if (tooManyFailures(loginId, now)) return TOO_MANY;
  const code = args.code.trim().toLowerCase();
  return telegramLoginSystem(async () => {
    const t = await pairingTarget({ ownerId, loginId, code, now });
    if (!t.ok) return t;
    const { chat, summary } = t;
    if (!previewTokenValid(args.previewToken, chat, loginId, code, now)) {
      return {
        ok: false as const,
        error: args.previewToken
          ? 'that preview no longer holds (it is over ten minutes old, or the code now names another chat): look the code up again, then confirm with the new preview token.'
          : 'a pairing confirm needs the preview token: look the code up first (without confirm), show the user whose chat it is, then confirm with that token.',
        code: 'preview_mismatch' as const,
      };
    }
    if (t.already) return { ok: true as const, already: true, chat: summary };
    // Only a pending chat whose code is still this one flips: two logins
    // racing for one code cannot both win.
    const flipped = await db
      .update(telegramChats)
      .set({
        allowlistStatus: 'allowed',
        loginId,
        pairingCode: null,
        pairingExpiresAt: null,
        pairingReplies: 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(telegramChats.id, chat.id),
          eq(telegramChats.allowlistStatus, 'pending'),
          eq(telegramChats.pairingCode, code),
        ),
      )
      .returning({ id: telegramChats.id });
    if (flipped.length === 0) return NO_SUCH_CODE;
    const [account] = await db
      .select()
      .from(telegramAccounts)
      .where(eq(telegramAccounts.id, chat.accountId))
      .limit(1);
    await notifyPaired({ ownerId, loginId, chat, botName: account?.botUsername ?? null });
    if (account) {
      await sendMessage(
        account,
        chat.telegramChatId,
        `Paired! Say hi to ${summary.agentName ?? 'your assistant'}.`,
      ).catch((err: unknown) => {
        // The chat is paired in the DB; the confirmation DM is best-effort.
        console.error('[telegram pair] confirm DM failed:', err);
      });
    }
    return { ok: true as const, already: false, chat: summary };
  });
}

/**
 * Tell the login in the app that a chat was paired to it (W7d fix round 1,
 * M3): one message in its own thread with the bot's assistant (the per-login
 * thread, 0269; a member's also reaches its phone as a chat push), naming the
 * chat and the bot, so a pairing it did not mean is seen. Best effort: the
 * chat stays paired whatever happens here. No model runs.
 */
async function notifyPaired(args: {
  ownerId: string;
  loginId: string;
  chat: TelegramChat;
  botName: string | null;
}): Promise<void> {
  try {
    const agent = await botAgent(args.chat.accountId);
    if (!agent) return;
    const bot = args.botName ? `@${args.botName}` : "this assistant's bot";
    await db.insert(assistantMessages).values({
      ownerId: args.ownerId,
      agentId: agent.id,
      loginId: args.loginId,
      direction: 'outbound',
      text: `Your Telegram ${noticeLabelOf(args.chat)} is now paired to you on ${bot}. If this was not you, unpair it in your Telegram chats.`,
      channel: 'web',
      data: { notice: 'telegram_paired', telegram_chat_id: args.chat.telegramChatId },
    });
  } catch (err) {
    console.error('[telegram pair] paired notice failed:', err);
  }
}

/**
 * Block or unpair chat `chatId` (the telegram_chats row id), by `actorLoginId`:
 * the chat's own login, a Moderator of its bot's workspace, or an Admin user
 * with the users area. `block` stops the chat for good (its messages are
 * dropped) until a Moderator unpairs it; `unpair` clears its login and puts
 * it back to pending, so the person can pair again with a new code. Never
 * pairs. `accountId`, when given, must be the chat's bot.
 */
export async function setChatPairing(args: {
  ownerId: string;
  actorLoginId: string;
  chatId: string;
  action: 'block' | 'unpair';
  accountId?: string;
}): Promise<{ ok: true; chat: PairedChatSummary } | PairingRefusal> {
  const { ownerId, actorLoginId, chatId, action } = args;
  return telegramLoginSystem(async () => {
    const [chat] = await db
      .select()
      .from(telegramChats)
      .where(
        and(
          eq(telegramChats.id, chatId),
          eq(telegramChats.userId, ownerId),
          ...(args.accountId ? [eq(telegramChats.accountId, args.accountId)] : []),
        ),
      )
      .limit(1);
    if (!chat) return { ok: false as const, error: 'chat not found.', code: 'not_found' as const };
    const own = !!chat.loginId && chat.loginId.toLowerCase() === actorLoginId.toLowerCase();
    if (
      !own &&
      !(await loginModeratesBot({ ownerId, loginId: actorLoginId, accountId: chat.accountId }))
    ) {
      // Nobody else's chat is named: a caller who may not moderate the bot
      // learns nothing about its chats.
      return { ok: false as const, error: 'chat not found.', code: 'not_found' as const };
    }
    await db
      .update(telegramChats)
      .set({
        allowlistStatus: action === 'block' ? 'denied' : 'pending',
        loginId: null,
        pairingCode: null,
        pairingExpiresAt: null,
        pairingReplies: 0,
        updatedAt: new Date(),
      })
      .where(eq(telegramChats.id, chat.id));
    return {
      ok: true as const,
      chat: {
        id: chat.id,
        telegramChatId: chat.telegramChatId,
        label: labelOf(chat),
        noticeLabel: noticeLabelOf(chat),
        agentName: await botAgentName(chat.accountId),
      },
    };
  });
}
