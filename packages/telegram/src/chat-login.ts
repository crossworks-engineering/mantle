/**
 * Telegram per paired user.
 *
 * A bot belongs to an assistant (channels.agent_id), so to one workspace. A
 * paired chat belongs to a USER (telegram_chats.login_id): the user pairs it
 * with the chat's code while signed in, and only for a bot whose assistant
 * is an assistant of a workspace the user is in. A turn on the chat runs as
 * that login in that workspace. A chat whose login is gone, disabled, or no
 * longer a user of the workspace is refused on its next message (a chat
 * whose login the box password rule holds is refused too, but stays
 * paired: docs/policy.md). Any
 * workspace's assistant may answer on Telegram.
 *
 * "The workspace of the chat" is the workspace of every assistant the chat
 * runs as: the bot's own assistant and the chat's responder override, when
 * it has one. An assistant with no workspace (a helper) counts the Admin
 * workspace. With no Admin workspace (the boot refuses such a brain) a
 * helper's chat matches no workspace and is refused.
 *
 * Moderators of the bot's workspace and Admin users with the users area may
 * block or unpair any chat of that bot, never pair it to someone else.
 *
 * The Telegram tables are granted to no role, and each rule is held in the
 * query itself. Every read here runs on the system pool by the named reason
 * 'login-telegram', never in a scope (systemWork refuses one).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, liveWorkspaceSql, systemWork, telegramChats } from '@mantle/db';
import { passwordHoldState, passwordPolicyMin } from '@mantle/config';
import { errorMessage, UUID_RE } from '@mantle/std';
import { log } from '@mantle/tracing';
import { botAgentIdSql } from './chat-assistant';

/**
 * A Telegram chat's login, its bot and the bot's assistant are read on the
 * system pool by the named reason 'login-telegram' (the workspace role reads
 * none of them). Every caller here runs on the system pool: the Telegram
 * turn and the poller, an Admin area's route or tool, the pairing door.
 * systemWork refuses a scope (the moderated chats screen reads by its
 * definer, 0293).
 */
function telegramSystemWork<T>(fn: () => Promise<T>): Promise<T> {
  return systemWork(fn, 'login-telegram');
}

/** Why a login may not use a chat, or null when it may. */
/** `password_hold`: the box password rule holds the chat's login (a
 *  password to change, or one not yet checked under the rule;
 *  docs/policy.md). The chat stays paired: it is refused until the person
 *  signs in or changes the password in the app. */
export type ChatLoginRefusal = 'no_login' | 'not_a_user' | 'no_assistant' | 'password_hold';

/** The one reply a chat gets when its login may not use it. Plain and
 *  short: the person reading it may not be a user of this brain at all. */
export const TELEGRAM_UNPAIRED_REPLY =
  'This chat is not paired to a user of this assistant now. Sign in to Mantle and pair it again with a new code.';

/** The reply a chat gets while the box password rule holds its login. */
export const TELEGRAM_PASSWORD_HOLD_REPLY =
  'Your Mantle password needs attention first. Sign in to Mantle in the app, then message me again.';

/** The `code` a pairing refusal carries, so a screen can tell it apart. */
export const TELEGRAM_NOT_A_USER_CODE = 'not_a_workspace_user';

/**
 * Whether `loginId` may use a chat on bot `accountId` (with responder
 * override `responderAgentId`): null when it may, else why not. Asked when
 * a chat is paired and again on every message.
 */
export async function chatLoginRefusal(args: {
  ownerId: string;
  loginId: string | null;
  accountId: string;
  responderAgentId: string | null;
}): Promise<ChatLoginRefusal | null> {
  const { ownerId, loginId, accountId, responderAgentId } = args;
  if (!loginId || !UUID_RE.test(loginId)) return 'no_login';
  const rows = (await telegramSystemWork(() =>
    db.execute(sql`
        with chat_agents as (
          select a.workspace_id
            from agents a
           where a.owner_id = ${ownerId}::uuid
             and (a.id = ${responderAgentId}::uuid
                  or a.id in (${botAgentIdSql(accountId)}))
        ), admin_ws as (
          select w.id from workspaces w
           where w.owner_id = ${ownerId}::uuid and w.is_admin
           limit 1
        )
        select
          (select count(*) from chat_agents)::int as agents,
          not exists (
            select 1 from chat_agents ca
             where not exists (
               select 1
                 from workspaces w
                 join workspace_users u on u.workspace_id = w.id and u.login_id = ${loginId}::uuid
                 join auth.users l on l.id = u.login_id and l.disabled_at is null
                where ${liveWorkspaceSql('w')}
                  and w.id = coalesce(ca.workspace_id, (select id from admin_ws))
             )
          ) as user_of_all
      `),
  )) as unknown as { agents: number; user_of_all: boolean }[];
  const r = rows[0];
  if (!r || r.agents === 0) return 'no_assistant';
  if (!r.user_of_all) return 'not_a_user';
  return (await loginPasswordHeld(loginId)) ? 'password_hold' : null;
}

/** Whether the box password rule holds `loginId` (@mantle/config
 *  passwordHoldState). With no rule: false, and nothing is read. */
async function loginPasswordHeld(loginId: string): Promise<boolean> {
  if (passwordPolicyMin() === null) return false;
  const rows = (await telegramSystemWork(() =>
    db.execute(sql`
      select must_change_password as flag, password_checked_min as checked
        from auth.users where id = ${loginId}::uuid
    `),
  )) as unknown as { flag: boolean; checked: number | null }[];
  const r = rows[0];
  return !!r && passwordHoldState(r.flag, r.checked) !== null;
}

let moderatesFailedLogged = false;

/**
 * Whether `loginId` may block or unpair any chat of bot `accountId`: a
 * Moderator of the bot's assistant's workspace (an assistant with no
 * workspace: the Admin workspace), or an Admin user whose users area is on.
 * The rule is one definer (mantle_tg_login_moderates, 0313), which the
 * block or unpair and the moderated chats screen ask too; this asks it on
 * the system pool. Fails closed.
 */
export async function loginModeratesBot(args: {
  ownerId: string;
  loginId: string;
  accountId: string;
}): Promise<boolean> {
  const { ownerId, loginId, accountId } = args;
  if (!UUID_RE.test(loginId)) return false;
  try {
    const rows = (await telegramSystemWork(() =>
      db.execute(
        sql`select "public"."mantle_tg_login_moderates"(${ownerId}::uuid, ${loginId}::uuid,
                                                       ${accountId}::uuid) as moderates`,
      ),
    )) as unknown as { moderates: boolean }[];
    return rows[0]?.moderates === true;
  } catch (err) {
    // Still no, but said once per process: a lost EXECUTE grant on the
    // rule shows in the log instead of silently emptying the screen.
    if (!moderatesFailedLogged) {
      moderatesFailedLogged = true;
      log('telegram').warn(`the Moderator rule was refused, it answers no: ${errorMessage(err)}`);
    }
    return false;
  }
}

/** One allowed chat paired to a login: what an outbound send needs. */
export type PairedChat = { id: string; accountId: string; telegramChatId: string };

/**
 * The allowed chat with Telegram id `telegramChatId` paired to `loginId`, on
 * this brain, most recently active first (a user who talks to two bots has
 * the same Telegram chat id on both). Null when there is none: an outbound
 * send then reaches nobody. Every outbound path asks this (a heartbeat's
 * delivery, a run's report, telegram_send and the operator tools), so a
 * chat is reached only for its own login.
 */
export async function pairedChatOf(args: {
  ownerId: string;
  loginId: string;
  telegramChatId: string;
}): Promise<PairedChat | null> {
  if (!UUID_RE.test(args.loginId)) return null;
  const [row] = await telegramSystemWork(() =>
    db
      .select({
        id: telegramChats.id,
        accountId: telegramChats.accountId,
        telegramChatId: telegramChats.telegramChatId,
      })
      .from(telegramChats)
      .where(
        and(
          eq(telegramChats.userId, args.ownerId),
          eq(telegramChats.loginId, args.loginId),
          eq(telegramChats.telegramChatId, args.telegramChatId),
          eq(telegramChats.allowlistStatus, 'allowed'),
        ),
      )
      .orderBy(desc(telegramChats.lastMessageAt))
      .limit(1),
  );
  return row ?? null;
}

/**
 * Send a chat whose turn was refused because it has no login, or its login
 * is no longer a user of the assistant's workspace, back to pending: its login
 * is cleared, so the person's next message gets a
 * fresh code and they can pair it again. Only while it is still allowed for
 * that same login: a chat paired again in the meantime is left alone.
 */
export async function unpairRefusedChat(args: {
  ownerId: string;
  chatId: string;
  loginId: string | null;
}): Promise<void> {
  await telegramSystemWork(() =>
    db
      .update(telegramChats)
      .set({
        allowlistStatus: 'pending',
        loginId: null,
        pairingCode: null,
        pairingExpiresAt: null,
        pairingReplies: 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(telegramChats.id, args.chatId),
          eq(telegramChats.userId, args.ownerId),
          eq(telegramChats.allowlistStatus, 'allowed'),
          args.loginId
            ? eq(telegramChats.loginId, args.loginId)
            : sql`${telegramChats.loginId} is null`,
        ),
      ),
  );
}
