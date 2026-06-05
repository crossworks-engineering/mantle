/**
 * Telegram ⇄ `channels` bridge (docs/comms-channels.md, Phase 1).
 *
 * The generic `channels` table is the new home for the transport binding
 * (which agent) + the sealed bot token. `telegram_accounts` stays the
 * transport-specific poll-state extension, linked 1:1 via `channel_id`.
 *
 * Two entry points, both idempotent:
 *   - `upsertTelegramChannel` — dual-write from the connect flow. Creates or
 *     updates the agent's telegram channel, re-seals the token under the
 *     channel's id (AAD), and links the account row. Plaintext token in hand.
 *   - `backfillTelegramChannels` — one-shot reconciliation for existing rows
 *     (run at agent boot). Decrypts each linked account's token (account-id
 *     AAD), then re-seals it into a channel (channel-id AAD). Never raw-copies
 *     `bot_token_enc` (§2 / §9 token-re-seal constraint).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { channels, db, telegramAccounts } from '@mantle/db';
import { open, seal } from '@mantle/crypto';

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

/**
 * Reconcile existing `telegram_accounts` into `channels`. For every linked
 * account (`responder_agent_id` set) that has no `channel_id` yet, decrypt its
 * token and re-seal it into a fresh channel bound to that agent. Idempotent and
 * cheap — skips accounts already linked. Returns the number of channels created.
 *
 * Runs at agent boot AND at poller startup (both processes have
 * MANTLE_MASTER_KEY); the SQL migration can't do this because AES-GCM re-seal
 * needs app crypto. Running it at poller startup too closes the deploy race
 * where the channel-gated poller would otherwise see zero channels until the
 * agent's backfill lands.
 *
 * `ownerId` optional: omit to reconcile every owner's accounts (the poller is
 * owner-agnostic); pass it to scope to one owner (the agent's single owner).
 */
export async function backfillTelegramChannels(ownerId?: string): Promise<number> {
  const accounts = await db
    .select()
    .from(telegramAccounts)
    .where(
      ownerId
        ? and(eq(telegramAccounts.userId, ownerId), isNull(telegramAccounts.channelId))
        : isNull(telegramAccounts.channelId),
    );

  let created = 0;
  for (const account of accounts) {
    // Only accounts bound to an agent can become a channel (a channel must
    // carry an agent_id). Unlinked/legacy bots are left channel-less.
    if (!account.responderAgentId) continue;
    let token: string;
    try {
      token = open(account.botTokenEnc, account.id);
    } catch (err) {
      console.error(
        `[telegram-channels] backfill: could not open token for @${account.botUsername} (${account.id}):`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    await upsertTelegramChannel({
      ownerId: account.userId,
      agentId: account.responderAgentId,
      accountId: account.id,
      botUsername: account.botUsername,
      branchPath: account.branchPath,
      token,
      enabled: account.enabled,
    });
    created += 1;
  }
  if (created > 0) {
    console.log(`[telegram-channels] backfill: created ${created} channel(s) from telegram_accounts`);
  }
  return created;
}
