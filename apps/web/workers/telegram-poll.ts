/**
 * Channel polling worker. Runs as a separate Node process during `pnpm dev`
 * and as the `telegram_poll` service in prod.
 *
 * Generic supervisor over a **channel-poller registry** (docs/comms-channels.md
 * §6). The source of truth for "what to poll" is the `channels` table: every
 * enabled channel whose `type` has a registered poller gets one long-poll loop.
 * Telegram is the only registered type today; Discord/Slack slot in as new
 * registry entries.
 *
 * For Telegram, the loop resolves the channel's 1:1 `telegram_accounts` state
 * row (offset, token, last_poll_*) and calls `pollOnce` exactly as before — the
 * channel just decides *which* accounts get polled (gated on `channels.enabled`
 * instead of the legacy `telegram_accounts.enabled`). The token still opens off
 * the account row during the dual-read transition.
 *
 * Single worker instance is assumed (Telegram long-poll is single-flight per
 * token); multi-instance would need an advisory lock per channel.
 *
 * Env loading via `--env-file-if-exists=.env.local` in package.json.
 */
import { eq } from 'drizzle-orm';
import { channels, db, telegramAccounts, type Channel, type TelegramAccount } from '@mantle/db';
import { backfillTelegramChannels, pollOnce, evictBot } from '@mantle/telegram';

const CHANNEL_REFRESH_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/** A transport poller. One long-poll loop is spawned per enabled channel of
 *  this `type`; `stop()` ends it. */
interface ChannelPoller {
  type: Channel['type'];
  startLoop(channel: Channel): { stop: () => void };
}

const telegramPoller: ChannelPoller = {
  type: 'telegram',
  startLoop: (channel) => startTelegramLoop(channel),
};

/** type → poller. Add Discord/Slack here alongside their `channel_type` enum
 *  value + credentials/config shape. */
const REGISTRY: Partial<Record<Channel['type'], ChannelPoller>> = {
  telegram: telegramPoller,
};

/** Active per-channel loops keyed by channel id. */
const loops = new Map<string, { stop: () => void }>();

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  if (!process.env.MANTLE_MASTER_KEY) throw new Error('MANTLE_MASTER_KEY must be set');

  console.log('[channel-poll] worker up');

  // Reconcile telegram_accounts → channels before the first refresh so the
  // channel-gated poll set is populated on a fresh deploy (closes the race
  // where this worker would otherwise poll nothing until the agent's backfill
  // lands). Owner-agnostic; idempotent; best-effort.
  try {
    await backfillTelegramChannels();
  } catch (err) {
    console.error('[channel-poll] channel backfill failed (will rely on agent boot):', err);
  }

  await refreshChannels();
  const interval = setInterval(refreshChannels, CHANNEL_REFRESH_MS);

  const shutdown = async () => {
    console.log('[channel-poll] shutting down…');
    clearInterval(interval);
    for (const { stop } of loops.values()) stop();
    loops.clear();
    // Give in-flight getUpdates a moment to settle.
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function refreshChannels(): Promise<void> {
  // setInterval doesn't await us — a PostgresError here (Postgres restarted,
  // briefly dropped connections) would otherwise be an UNHANDLED rejection that
  // kills the worker. Catch, log, skip this pass; the next tick retries. That
  // cadence is itself the backoff.
  let rows: Channel[];
  try {
    rows = await db.select().from(channels).where(eq(channels.enabled, true));
  } catch (err) {
    console.error('[channel-poll] channel refresh failed (will retry next tick):', err);
    return;
  }
  const live = new Set<string>();

  for (const channel of rows) {
    const poller = REGISTRY[channel.type];
    if (!poller) continue; // No poller registered for this type yet.
    live.add(channel.id);
    if (!loops.has(channel.id)) {
      console.log(`[channel-poll] starting ${channel.type} loop for ${channel.displayName}`);
      loops.set(channel.id, poller.startLoop(channel));
    }
  }
  for (const [id, ctrl] of loops.entries()) {
    if (!live.has(id)) {
      console.log(`[channel-poll] stopping loop for channel ${id}`);
      ctrl.stop();
      loops.delete(id);
    }
  }
}

function startTelegramLoop(channel: Channel): { stop: () => void } {
  let stopped = false;
  let backoffMs = BACKOFF_BASE_MS;
  // Track the resolved account id so we can evict its cached Bot when the loop
  // ends (token rotation / disable). Set on the first successful re-read.
  let accountId: string | null = null;

  void (async () => {
    while (!stopped) {
      // Re-read the channel's 1:1 account each iteration so we pick up offset
      // updates (we have one poller, but this keeps lastUpdateOffset honest)
      // and token rotations.
      //
      // Disable race: there's a ≤25s window between this check and pollOnce
      // returning where a disable via the UI won't take effect — the long-poll
      // completes, delivers any updates, then the supervisor's next refresh
      // sees the channel disabled and stops the loop. Mild; tolerable.
      //
      // Own try/catch: a transient PostgresError here must NOT end the loop —
      // the row is almost certainly still there. Back off and retry. (Without
      // this the throw escapes the IIFE as an unhandled rejection and kills the
      // worker.) A successful query that returns no row — a genuine misconfig
      // (channel with no account) — ends the loop, as it should.
      let account: TelegramAccount | undefined;
      try {
        [account] = await db
          .select()
          .from(telegramAccounts)
          .where(eq(telegramAccounts.channelId, channel.id))
          .limit(1);
      } catch (err) {
        console.error(`[channel-poll] ${channel.displayName} account re-read failed:`, err);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        continue;
      }
      if (!account) {
        console.log(
          `[channel-poll] no telegram_accounts row for channel ${channel.id} (${channel.displayName}), ending loop`,
        );
        return;
      }
      accountId = account.id;
      try {
        const { delivered, updatesReceived } = await pollOnce(account, 25);
        if (updatesReceived > 0) {
          console.log(
            `[channel-poll] ${channel.displayName} — ${updatesReceived} updates, ${delivered} delivered`,
          );
        }
        backoffMs = BACKOFF_BASE_MS;
      } catch (err) {
        console.error(`[channel-poll] ${channel.displayName} error:`, err);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  })();

  return {
    stop: () => {
      stopped = true;
      if (accountId) evictBot(accountId);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Backstop: every known DB-touching path above is wrapped + backs off, but a
// rejection that slips past should log and keep the long-poll worker alive
// rather than crash-loop. Docker's restart:unless-stopped would bounce us
// anyway; staying up is strictly better.
process.on('unhandledRejection', (reason) => {
  console.error('[channel-poll] unhandledRejection (kept alive):', reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
