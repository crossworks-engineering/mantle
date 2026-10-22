/**
 * Which assistant a Telegram chat runs as, in one place.
 *
 * A bot belongs to an assistant: the agent of the channel its account is
 * linked to (telegram_accounts.channel_id to channels.agent_id). A chat may
 * name its own (telegram_chats.responder_agent_id, the override). A turn on
 * the chat is answered by the override when set, else by the bot's
 * assistant (chatAnsweringAgentId). Who may pair and use the chat is asked
 * of every assistant it runs as, both (chat-login.ts chatLoginRefusal).
 *
 * The bot's assistant is read here only: botAgentIdSql as a subquery (the
 * turn's own row, the pairing rule's assistants) and botAgentId as a
 * statement. Each runs on whatever pool its caller is on; nothing here
 * writes.
 */
import { eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { channels, db, telegramAccounts } from '@mantle/db';

/** The assistant that answers a chat: its override, else its bot's. */
export function chatAnsweringAgentId(
  overrideAgentId: string | null | undefined,
  botAgentId: string | null | undefined,
): string | null {
  return overrideAgentId ?? botAgentId ?? null;
}

/**
 * A subquery of the bot's assistant's id for account `account` (an id, or
 * a column or expression of one): no row when the account has no channel.
 * Wrap it in parentheses as a scalar (`(${botAgentIdSql(x)})`, null then)
 * or use it after `in`.
 */
export function botAgentIdSql(account: string | SQLWrapper): SQL {
  const id = typeof account === 'string' ? sql`${account}::uuid` : sql`${account}`;
  return sql`select ch.agent_id
                from channels ch
                join telegram_accounts t on t.channel_id = ch.id
               where t.id = ${id}`;
}

/** The bot's assistant's id for account `accountId`, or null. */
export async function botAgentId(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ agentId: channels.agentId })
    .from(telegramAccounts)
    .innerJoin(channels, eq(channels.id, telegramAccounts.channelId))
    .where(eq(telegramAccounts.id, accountId))
    .limit(1);
  return row?.agentId ?? null;
}
