/**
 * Per-agent Telegram bot binding for the /settings/agents form. The binding
 * (which agent) + the sealed bot token live in the generic `channels` table
 * (docs/comms-channels.md); `telegram_accounts` is the transport-specific
 * poll-state extension, linked 1:1 via `channel_id`. Any agent can attach a
 * bot — `role` no longer gates transport.
 *
 * Connect flow: validate the token via Telegram's getMe (also yields the bot
 * username + branch path), upsert the account's poll-state row, then write the
 * channel (token + binding) via `upsertTelegramChannel`.
 */
import { and, eq } from 'drizzle-orm';
import { agents, channels, db, telegramAccounts, telegramChats } from '@mantle/db';
import { disableTelegramChannel, sendMessage, upsertTelegramChannel } from '@mantle/telegram';

export type AgentTelegramBinding = {
  accountId: string;
  botUsername: string;
  enabled: boolean;
  lastPollAt: string | null;
  lastPollError: string | null;
};

/** Thrown for user-fixable problems (bad token, username already taken). The
 *  API layer surfaces `.message` to the form. */
export class TelegramTokenError extends Error {}

async function getMe(token: string): Promise<{ id: number; username: string }> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  } catch {
    throw new TelegramTokenError('Could not reach Telegram. Check your connection and try again.');
  }
  if (res.status === 401) throw new TelegramTokenError('Telegram rejected this token (401).');
  if (!res.ok) throw new TelegramTokenError(`Telegram getMe failed (HTTP ${res.status}).`);
  const body = (await res.json().catch(() => null)) as {
    ok: boolean;
    result?: { id: number; username?: string };
  } | null;
  if (!body?.ok || !body.result?.username) {
    throw new TelegramTokenError('Telegram accepted the request but returned no bot username.');
  }
  return { id: body.result.id, username: body.result.username };
}

type AccountRow = typeof telegramAccounts.$inferSelect;

function toBinding(account: AccountRow, channelEnabled: boolean): AgentTelegramBinding {
  return {
    accountId: account.id,
    botUsername: account.botUsername,
    // The channel is the source of truth for enabled/disabled now.
    enabled: channelEnabled,
    lastPollAt: account.lastPollAt?.toISOString() ?? null,
    lastPollError: account.lastPollError,
  };
}

/** The account row + its channel.enabled for the agent's telegram channel. */
async function accountForAgent(
  ownerId: string,
  agentId: string,
): Promise<{ account: AccountRow; channelEnabled: boolean } | null> {
  const [row] = await db
    .select({ account: telegramAccounts, channelEnabled: channels.enabled })
    .from(telegramAccounts)
    .innerJoin(channels, eq(telegramAccounts.channelId, channels.id))
    .where(
      and(
        eq(channels.ownerId, ownerId),
        eq(channels.agentId, agentId),
        eq(channels.type, 'telegram'),
      ),
    )
    .limit(1);
  return row ? { account: row.account, channelEnabled: row.channelEnabled } : null;
}

/** The agent that owns the channel linked to an account, if any. */
async function channelAgentForAccount(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ agentId: channels.agentId })
    .from(channels)
    .innerJoin(telegramAccounts, eq(telegramAccounts.channelId, channels.id))
    .where(eq(telegramAccounts.id, accountId))
    .limit(1);
  return row?.agentId ?? null;
}

/** The bot currently bound to this agent, or null. */
export async function getAgentTelegram(
  ownerId: string,
  agentId: string,
): Promise<AgentTelegramBinding | null> {
  const found = await accountForAgent(ownerId, agentId);
  return found ? toBinding(found.account, found.channelEnabled) : null;
}

/**
 * Validate `token`, then bind its bot to `agentId` — updating the agent's
 * existing bound bot, adopting an existing same-username account (e.g. a
 * CLI-seeded bot), or inserting a new account. The token + agent binding land
 * on the `channels` row (`upsertTelegramChannel`); the account row holds only
 * poll state. Re-enables the channel.
 */
export async function connectAgentTelegram(
  ownerId: string,
  agentId: string,
  token: string,
): Promise<AgentTelegramBinding> {
  const trimmed = token.trim();
  if (!trimmed) throw new TelegramTokenError('Paste a bot token.');
  const me = await getMe(trimmed);
  const branchPath = `inbox.telegram_${me.username.toLowerCase()}`;

  const byAgent = (await accountForAgent(ownerId, agentId))?.account;
  const [byUsername] = await db
    .select()
    .from(telegramAccounts)
    .where(and(eq(telegramAccounts.userId, ownerId), eq(telegramAccounts.botUsername, me.username)))
    .limit(1);

  // The bot is already owned by a different agent's channel — refuse to steal it.
  if (byUsername) {
    const owner = await channelAgentForAccount(byUsername.id);
    if (owner && owner !== agentId) {
      throw new TelegramTokenError(`@${me.username} is already linked to another agent.`);
    }
  }

  const target = byAgent ?? byUsername;
  let accountId: string;
  if (target) {
    accountId = target.id;
    // Pointing this row at a *different* bot? Telegram update-ids are per-bot,
    // so the old bot's offset is meaningless for the new one — carrying it over
    // can skip past the new bot's early messages. Reset so its stream is read
    // from the start. (Same-bot token rotation keeps the offset.)
    const botChanged = target.botUsername !== me.username;
    await db
      .update(telegramAccounts)
      .set({
        botUsername: me.username,
        branchPath,
        enabled: true,
        lastPollError: null,
        ...(botChanged ? { lastUpdateOffset: 0 } : {}),
        updatedAt: new Date(),
      })
      .where(eq(telegramAccounts.id, accountId));
  } else {
    const [inserted] = await db
      .insert(telegramAccounts)
      .values({
        userId: ownerId,
        botUsername: me.username,
        branchPath,
        enabled: true,
      })
      .returning({ id: telegramAccounts.id });
    accountId = inserted!.id;
  }

  // The channel holds the token (sealed under the channel id) + the agent
  // binding, and links the account via channel_id. This is the source of truth.
  await upsertTelegramChannel({
    ownerId,
    agentId,
    accountId,
    botUsername: me.username,
    branchPath,
    token: trimmed,
    enabled: true,
  });

  const binding = await getAgentTelegram(ownerId, agentId);
  if (!binding) throw new Error('failed to read back telegram binding');
  return binding;
}

/**
 * Unlink the bot from the agent and stop polling. Disables the channel (the
 * poll gate) and the account; keeps both rows + message history (a hard delete
 * would cascade telegram_chats + telegram_messages).
 */
export async function disconnectAgentTelegram(ownerId: string, agentId: string): Promise<void> {
  // Disable the channel — the poll gate. Keeps the row + history.
  await disableTelegramChannel(ownerId, agentId);
  // Also flip the account's own enabled flag for consistency (vestigial poll
  // state now that the channel gates polling).
  const found = await accountForAgent(ownerId, agentId);
  if (found) {
    await db
      .update(telegramAccounts)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(telegramAccounts.id, found.account.id));
  }
}

export type AgentTelegramChat = {
  id: string;
  telegramChatId: string;
  label: string;
  status: 'pending' | 'allowed' | 'denied';
  lastMessageAt: string | null;
};

const STATUS_ORDER: Record<AgentTelegramChat['status'], number> = {
  pending: 0,
  allowed: 1,
  denied: 2,
};

/**
 * Chats this agent's bot has seen — pending pairing requests first, then
 * allowed, then denied; recent within each. Powers the in-form pairing UI so
 * the owner can approve a DM without copying a code into the MCP tool.
 */
export async function listAgentTelegramChats(
  ownerId: string,
  agentId: string,
): Promise<AgentTelegramChat[]> {
  const binding = await getAgentTelegram(ownerId, agentId);
  if (!binding) return [];
  const rows = await db
    .select()
    .from(telegramChats)
    .where(and(eq(telegramChats.userId, ownerId), eq(telegramChats.accountId, binding.accountId)));
  return rows
    .map((r) => ({
      id: r.id,
      telegramChatId: r.telegramChatId,
      label: r.title ?? (r.username ? `@${r.username}` : r.telegramChatId),
      status: r.allowlistStatus,
      lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
    }))
    .sort((a, b) => {
      const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (s !== 0) return s;
      return (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '');
    });
}

/**
 * Allow or deny a chat on this agent's bot (the UI equivalent of the
 * `telegram_pair` MCP tool, keyed by chat id since the owner is authenticated).
 * Allowing clears the pairing code and sends a best-effort confirmation DM.
 */
export async function setAgentTelegramChatStatus(
  ownerId: string,
  agentId: string,
  chatId: string,
  status: 'allowed' | 'denied',
): Promise<void> {
  const binding = await getAgentTelegram(ownerId, agentId);
  if (!binding) throw new TelegramTokenError('No bot is linked to this agent.');
  const [chat] = await db
    .select()
    .from(telegramChats)
    .where(
      and(
        eq(telegramChats.id, chatId),
        eq(telegramChats.userId, ownerId),
        eq(telegramChats.accountId, binding.accountId),
      ),
    )
    .limit(1);
  if (!chat) throw new TelegramTokenError('Chat not found for this bot.');

  await db
    .update(telegramChats)
    .set({
      allowlistStatus: status,
      pairingCode: null,
      pairingExpiresAt: null,
      pairingReplies: 0,
      updatedAt: new Date(),
    })
    .where(eq(telegramChats.id, chat.id));

  if (status === 'allowed') {
    const [account] = await db
      .select()
      .from(telegramAccounts)
      .where(eq(telegramAccounts.id, binding.accountId))
      .limit(1);
    if (account) {
      const [agentRow] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      const name = agentRow?.name ?? 'your assistant';
      // Best-effort — the chat is paired in the DB regardless.
      await sendMessage(account, chat.telegramChatId, `Paired! Say hi to ${name}.`).catch((err) => {
        console.error('[telegram pair] confirm DM failed:', err);
      });
    }
  }
}
