/**
 * Telegram ⇄ `channels` bridge (docs/comms-channels.md).
 *
 * The generic `channels` table is the home for the transport binding (which
 * agent) + the sealed bot token (`credentials_enc`). `telegram_accounts` is the
 * transport-specific poll-state extension, linked 1:1 via `channel_id`.
 *
 *   - `upsertTelegramChannel` — the connect flow's write. Creates or updates the
 *     agent's telegram channel, seals the token under the channel's id (AAD),
 *     and links the account row. Plaintext token in hand.
 *   - `disableTelegramChannel` — disconnect (disable, keep history).
 *
 * (The one-shot `telegram_accounts → channels` backfill that ran during the
 * additive rollout is gone post-cleanup: the token now lives only on the
 * channel, so there's nothing left to migrate.)
 */
import { and, eq } from 'drizzle-orm';
import { channels, db, telegramAccounts } from '@mantle/db';
import { seal } from '@mantle/crypto';

/** Create/refresh the telegram `channels` row for an agent and link its
 *  account. Returns the channel id. The token is provided in plaintext (the
 *  connect flow already has it) and sealed under the channel id as AAD. */
export async function upsertTelegramChannel(args: {
  ownerId: string;
  agentId: string;
  accountId: string;
  botUsername: string;
  branchPath: string;
  token: string;
  enabled?: boolean;
}): Promise<string> {
  const { ownerId, agentId, accountId, botUsername, branchPath, token } = args;
  const enabled = args.enabled ?? true;
  const displayName = `@${botUsername}`;
  const config = { bot_username: botUsername, branch_path: branchPath };

  // Find an existing channel to update: prefer the one this account is already
  // linked to, else the agent's existing telegram channel (the unique
  // (agent_id, type) binding). Either way we reuse + re-seal in place.
  const [byAccount] = accountId
    ? await db
        .select({ id: channels.id })
        .from(channels)
        .innerJoin(telegramAccounts, eq(telegramAccounts.channelId, channels.id))
        .where(eq(telegramAccounts.id, accountId))
        .limit(1)
    : [];
  const [byAgent] = byAccount
    ? [byAccount]
    : await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.agentId, agentId), eq(channels.type, 'telegram')))
        .limit(1);

  let channelId: string;
  if (byAgent) {
    channelId = byAgent.id;
    await db
      .update(channels)
      .set({
        ownerId,
        agentId,
        displayName,
        config,
        enabled,
        credentialsEnc: seal(token, channelId).ciphertext,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, channelId));
  } else {
    // Insert with a no-AAD seal first (we don't have the row id yet), then
    // re-seal under the real id — same two-step the account flow uses.
    const [inserted] = await db
      .insert(channels)
      .values({
        ownerId,
        agentId,
        type: 'telegram',
        displayName,
        config,
        enabled,
        credentialsEnc: seal(token).ciphertext,
      })
      .returning({ id: channels.id });
    channelId = inserted!.id;
    await db
      .update(channels)
      .set({ credentialsEnc: seal(token, channelId).ciphertext })
      .where(eq(channels.id, channelId));
  }

  // Link the account (1:1). Idempotent.
  await db
    .update(telegramAccounts)
    .set({ channelId, updatedAt: new Date() })
    .where(eq(telegramAccounts.id, accountId));

  return channelId;
}

/** Disable + unlink the telegram channel for an agent (the channel-side mirror
 *  of disconnectAgentTelegram). Keeps the row + history; flips enabled=false. */
export async function disableTelegramChannel(ownerId: string, agentId: string): Promise<void> {
  await db
    .update(channels)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(channels.ownerId, ownerId),
        eq(channels.agentId, agentId),
        eq(channels.type, 'telegram'),
      ),
    );
}
