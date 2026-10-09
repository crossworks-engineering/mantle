/**
 * The level lookup behind the pairing refusals (access matrix T21, option 3;
 * the rules themselves are in ./level).
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { agents, channels, db, telegramAccounts } from '@mantle/db';
import { isBelowAdminAgent } from './level';

/** A chat's agent that is below admin. */
export type BelowAdminChatAgent = { id: string; slug: string; name: string; audience: string };

/**
 * The below-admin agent, if any, among the agents a Telegram chat would run
 * as: the bot's own agent (the account's channel) and the chat's responder
 * override. One query. Null when every one of them is admin-level, or when
 * neither exists (pairing then pairs a chat that no agent answers, which the
 * turn refuses on its own).
 */
export async function belowAdminChatAgent(
  ownerId: string,
  accountId: string,
  responderAgentId: string | null,
): Promise<BelowAdminChatAgent | null> {
  const botAgent = inArray(
    agents.id,
    db
      .select({ id: channels.agentId })
      .from(channels)
      .innerJoin(telegramAccounts, eq(telegramAccounts.channelId, channels.id))
      .where(eq(telegramAccounts.id, accountId)),
  );
  const rows = await db
    .select({ id: agents.id, slug: agents.slug, name: agents.name, audience: agents.audience })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        responderAgentId ? or(botAgent, eq(agents.id, responderAgentId)) : botAgent,
      ),
    );
  return rows.find(isBelowAdminAgent) ?? null;
}
