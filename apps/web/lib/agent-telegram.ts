/**
 * Per-responder Telegram bot binding. Lets a responder agent's bot token be
 * entered + managed from the /settings/agents form instead of the CLI seed
 * script. The token still lives in `telegram_accounts.bot_token_enc` (AES-GCM
 * sealed, AAD-bound to the account row id); we just add the
 * `responder_agent_id` link and a UI on top.
 *
 * Connect flow mirrors scripts/seed-telegram.ts: validate the token via
 * Telegram's getMe (also yields the bot username + branch path), then seal.
 */
import { and, eq } from 'drizzle-orm';
import { db, telegramAccounts } from '@mantle/db';
import { seal } from '@mantle/crypto';

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
  const body = (await res.json().catch(() => null)) as
    | { ok: boolean; result?: { id: number; username?: string } }
    | null;
  if (!body?.ok || !body.result?.username) {
    throw new TelegramTokenError('Telegram accepted the request but returned no bot username.');
  }
  return { id: body.result.id, username: body.result.username };
}

function toBinding(row: typeof telegramAccounts.$inferSelect): AgentTelegramBinding {
  return {
    accountId: row.id,
    botUsername: row.botUsername,
    enabled: row.enabled,
    lastPollAt: row.lastPollAt?.toISOString() ?? null,
    lastPollError: row.lastPollError,
  };
}

/** The bot currently bound to this responder agent, or null. */
export async function getAgentTelegram(
  ownerId: string,
  agentId: string,
): Promise<AgentTelegramBinding | null> {
  const [row] = await db
    .select()
    .from(telegramAccounts)
    .where(
      and(eq(telegramAccounts.userId, ownerId), eq(telegramAccounts.responderAgentId, agentId)),
    )
    .limit(1);
  return row ? toBinding(row) : null;
}

/**
 * Validate `token`, then bind its bot to `agentId` — updating the agent's
 * existing bound row, adopting an existing same-username row (e.g. a
 * CLI-seeded bot), or inserting a new one. Re-enables polling.
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

  const [byAgent] = await db
    .select()
    .from(telegramAccounts)
    .where(
      and(eq(telegramAccounts.userId, ownerId), eq(telegramAccounts.responderAgentId, agentId)),
    )
    .limit(1);
  const [byUsername] = await db
    .select()
    .from(telegramAccounts)
    .where(
      and(eq(telegramAccounts.userId, ownerId), eq(telegramAccounts.botUsername, me.username)),
    )
    .limit(1);

  // The bot is already owned by a different responder — refuse to steal it.
  if (byUsername && byUsername.responderAgentId && byUsername.responderAgentId !== agentId) {
    throw new TelegramTokenError(`@${me.username} is already linked to another agent.`);
  }

  const target = byAgent ?? byUsername;
  let accountId: string;
  if (target) {
    accountId = target.id;
    await db
      .update(telegramAccounts)
      .set({
        botUsername: me.username,
        branchPath,
        responderAgentId: agentId,
        enabled: true,
        botTokenEnc: seal(trimmed, accountId).ciphertext,
        lastPollError: null,
        updatedAt: new Date(),
      })
      .where(eq(telegramAccounts.id, accountId));
  } else {
    // Insert disabled first so the poll worker can't read a non-AAD-bound
    // token in the window before we re-seal it against the new row id.
    const [inserted] = await db
      .insert(telegramAccounts)
      .values({
        userId: ownerId,
        botUsername: me.username,
        branchPath,
        responderAgentId: agentId,
        enabled: false,
        botTokenEnc: seal(trimmed).ciphertext,
      })
      .returning({ id: telegramAccounts.id });
    accountId = inserted!.id;
    await db
      .update(telegramAccounts)
      .set({ botTokenEnc: seal(trimmed, accountId).ciphertext, enabled: true })
      .where(eq(telegramAccounts.id, accountId));
  }

  const binding = await getAgentTelegram(ownerId, agentId);
  if (!binding) throw new Error('failed to read back telegram binding');
  return binding;
}

/**
 * Unlink the bot from the agent and stop polling. Keeps the row + its message
 * history (a hard delete would cascade telegram_chats + telegram_messages).
 */
export async function disconnectAgentTelegram(ownerId: string, agentId: string): Promise<void> {
  await db
    .update(telegramAccounts)
    .set({ responderAgentId: null, enabled: false, updatedAt: new Date() })
    .where(
      and(eq(telegramAccounts.userId, ownerId), eq(telegramAccounts.responderAgentId, agentId)),
    );
}
