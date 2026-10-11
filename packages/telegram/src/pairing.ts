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
import { and, eq } from 'drizzle-orm';
import {
  agents,
  asSystem,
  authUsers,
  channels,
  db,
  telegramAccounts,
  telegramChats,
} from '@mantle/db';
import { chatLoginRefusal, loginModeratesBot, TELEGRAM_NOT_A_USER_CODE } from './chat-login';
import { sendMessage } from './outbound';

/** A refusal: the reply text, and a code a screen can tell apart. */
export type PairingRefusal = { ok: false; error: string; code: PairingRefusalCode };
export type PairingRefusalCode =
  | 'no_such_code'
  | 'code_expired'
  | 'not_a_workspace_user'
  | 'no_assistant'
  | 'paired_to_another'
  | 'too_many_attempts'
  | 'not_found'
  | 'not_allowed';

/** The chat a pairing or a block acted on. */
export type PairedChatSummary = {
  id: string;
  telegramChatId: string;
  label: string;
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

/** The name of the assistant a bot belongs to, or null. */
async function botAgentName(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: agents.name })
    .from(telegramAccounts)
    .innerJoin(channels, eq(channels.id, telegramAccounts.channelId))
    .innerJoin(agents, eq(agents.id, channels.agentId))
    .where(eq(telegramAccounts.id, accountId))
    .limit(1);
  return row?.name ?? null;
}

/** Refusal text for a login that is not a user of the bot's workspace. */
export const NOT_A_WORKSPACE_USER_ERROR =
  "you are not a user of this bot's assistant's workspace, so you cannot pair a chat to it. Ask a Moderator of that workspace to add you first.";

/**
 * Pair the chat holding `code` to `loginId` (the caller, never anyone
 * else). The chat must be pending with a live code, on this brain, on a bot
 * whose assistant's workspace the login is a user of. A chat already paired
 * to this login answers `already` (no change); one paired to another login
 * is refused. A best-effort confirmation DM follows.
 */
export async function pairChatWithCode(args: {
  ownerId: string;
  loginId: string;
  code: string;
}): Promise<{ ok: true; already: boolean; chat: PairedChatSummary } | PairingRefusal> {
  const { ownerId, loginId } = args;
  const now = Date.now();
  if (tooManyFailures(loginId, now)) {
    return {
      ok: false,
      error: 'too many wrong pairing codes: wait ten minutes, then try the newest code again.',
      code: 'too_many_attempts',
    };
  }
  const code = args.code.trim().toLowerCase();
  return asSystem(async () => {
    const [chat] = await db
      .select()
      .from(telegramChats)
      .where(and(eq(telegramChats.pairingCode, code), eq(telegramChats.userId, ownerId)))
      .limit(1);
    if (!chat) {
      noteFailure(loginId, now);
      return {
        ok: false as const,
        error: 'no pending pairing with that code: send the bot a new message for a fresh one.',
        code: 'no_such_code' as const,
      };
    }
    // Client logins have no Telegram (no client chat exists yet).
    const [who] = await db
      .select({ role: authUsers.role })
      .from(authUsers)
      .where(eq(authUsers.id, loginId))
      .limit(1);
    if (!who || who.role === 'client') {
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
    const agentName = await botAgentName(chat.accountId);
    const summary: PairedChatSummary = {
      id: chat.id,
      telegramChatId: chat.telegramChatId,
      label: labelOf(chat),
      agentName,
    };
    if (chat.allowlistStatus === 'allowed') {
      if (chat.loginId && chat.loginId.toLowerCase() === loginId.toLowerCase()) {
        return { ok: true as const, already: true, chat: summary };
      }
      return {
        ok: false as const,
        error: 'this chat is paired to another user. Ask a Moderator to unpair it first.',
        code: 'paired_to_another' as const,
      };
    }
    if (chat.allowlistStatus !== 'pending') {
      noteFailure(loginId, now);
      return {
        ok: false as const,
        error: 'no pending pairing with that code: send the bot a new message for a fresh one.',
        code: 'no_such_code' as const,
      };
    }
    if (chat.pairingExpiresAt && chat.pairingExpiresAt.getTime() < now) {
      return {
        ok: false as const,
        error: 'that code expired: send the bot a new message for a fresh one.',
        code: 'code_expired' as const,
      };
    }
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
    if (flipped.length === 0) {
      return {
        ok: false as const,
        error: 'no pending pairing with that code: send the bot a new message for a fresh one.',
        code: 'no_such_code' as const,
      };
    }
    const [account] = await db
      .select()
      .from(telegramAccounts)
      .where(eq(telegramAccounts.id, chat.accountId))
      .limit(1);
    if (account) {
      await sendMessage(
        account,
        chat.telegramChatId,
        `Paired! Say hi to ${agentName ?? 'your assistant'}.`,
      ).catch((err: unknown) => {
        // The chat is paired in the DB; the confirmation DM is best-effort.
        console.error('[telegram pair] confirm DM failed:', err);
      });
    }
    return { ok: true as const, already: false, chat: summary };
  }, 'login-telegram');
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
  return asSystem(async () => {
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
        agentName: await botAgentName(chat.accountId),
      },
    };
  }, 'login-telegram');
}
