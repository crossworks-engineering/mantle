/**
 * Telegram per paired user (workspaces W7d, plan 5.4).
 *
 * A bot belongs to an assistant (channels.agent_id), so to one workspace. A
 * paired chat belongs to a USER (telegram_chats.login_id): the user pairs it
 * with the chat's code while signed in, and only for a bot whose assistant
 * is an assistant of a workspace the user is in. A turn on the chat runs as
 * that login in that workspace. A chat whose login is gone, disabled, or no
 * longer a user of the workspace is refused on its next message. Any
 * workspace's assistant may answer on Telegram (the old rule, only an
 * admin-level agent, is gone).
 *
 * "The workspace of the chat" is the workspace of every assistant the chat
 * runs as: the bot's own assistant and the chat's responder override, when
 * it has one. An assistant with no workspace (a helper) counts the Admin
 * workspace. A brain not on workspaces yet: only the anchor login.
 *
 * Moderators of the bot's workspace and Admin users with the users area may
 * block or unpair any chat of that bot, never pair it to someone else.
 *
 * Every read here leaves a request or turn scope for the system pool by the
 * named reason 'login-telegram': the Telegram tables are granted to no role,
 * and each rule is held in the query itself.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { asSystem, db, loginHasArea, telegramChats } from '@mantle/db';

/** Why a login may not use a chat, or null when it may. */
export type ChatLoginRefusal = 'no_login' | 'not_a_user' | 'no_assistant';

/** The one reply a chat gets when its login may not use it. Plain and
 *  short: the person reading it may not be a user of this brain at all. */
export const TELEGRAM_UNPAIRED_REPLY =
  'This chat is not paired to a user of this assistant now. Sign in to Mantle and pair it again with a new code.';

/** The `code` a pairing refusal carries, so a screen can tell it apart. */
export const TELEGRAM_NOT_A_USER_CODE = 'not_a_workspace_user';

/** Whether `s` looks like a uuid (a login id), so a bad value never reaches SQL. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const rows = (await asSystem(
    () =>
      db.execute(sql`
        with chat_agents as (
          select a.workspace_id
            from agents a
           where a.owner_id = ${ownerId}::uuid
             and (a.id = ${responderAgentId}::uuid
                  or a.id in (select ch.agent_id
                                from channels ch
                                join telegram_accounts t on t.channel_id = ch.id
                               where t.id = ${accountId}::uuid))
        ), admin_ws as (
          select w.id from workspaces w
           where w.owner_id = ${ownerId}::uuid and w.is_admin
           limit 1
        )
        select
          (select count(*) from chat_agents)::int as agents,
          exists (select 1 from admin_ws) as on_ws,
          not exists (
            select 1 from chat_agents ca
             where not exists (
               select 1
                 from workspaces w
                 join workspace_users u on u.workspace_id = w.id and u.login_id = ${loginId}::uuid
                 join auth.users l on l.id = u.login_id and l.disabled_at is null
                where w.archived_at is null
                  and w.id = coalesce(ca.workspace_id, (select id from admin_ws))
             )
          ) as user_of_all
      `),
    'login-telegram',
  )) as unknown as { agents: number; on_ws: boolean; user_of_all: boolean }[];
  const r = rows[0];
  if (!r || r.agents === 0) return 'no_assistant';
  if (!r.on_ws) return loginId.toLowerCase() === ownerId.toLowerCase() ? null : 'not_a_user';
  return r.user_of_all ? null : 'not_a_user';
}

/**
 * Whether `loginId` may block or unpair any chat of bot `accountId`: a
 * Moderator of the bot's assistant's workspace (an assistant with no
 * workspace: the Admin workspace), or an Admin user whose users area is on.
 * A brain not on workspaces: the anchor login. Fails closed.
 */
export async function loginModeratesBot(args: {
  ownerId: string;
  loginId: string;
  accountId: string;
}): Promise<boolean> {
  const { ownerId, loginId, accountId } = args;
  if (!UUID_RE.test(loginId)) return false;
  try {
    const rows = (await asSystem(
      () =>
        db.execute(sql`
          with admin_ws as (
            select w.id from workspaces w
             where w.owner_id = ${ownerId}::uuid and w.is_admin
             limit 1
          )
          select
            exists (select 1 from admin_ws) as on_ws,
            exists (
              select 1
                from telegram_accounts t
                join channels ch on ch.id = t.channel_id
                join agents a on a.id = ch.agent_id and a.owner_id = ${ownerId}::uuid
                join workspaces w on w.id = coalesce(a.workspace_id, (select id from admin_ws))
                                 and w.archived_at is null
                join workspace_users u on u.workspace_id = w.id
                                      and u.login_id = ${loginId}::uuid and u.moderator
                join auth.users l on l.id = u.login_id and l.disabled_at is null
               where t.id = ${accountId}::uuid
            ) as moderates
        `),
      'login-telegram',
    )) as unknown as { on_ws: boolean; moderates: boolean }[];
    const r = rows[0];
    if (!r) return false;
    if (!r.on_ws) return loginId.toLowerCase() === ownerId.toLowerCase();
    if (r.moderates) return true;
    return await loginHasArea(loginId, 'users');
  } catch {
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
  const [row] = await asSystem(
    () =>
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
    'login-telegram',
  );
  return row ?? null;
}
