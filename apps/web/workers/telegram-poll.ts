/**
 * Telegram polling worker. Runs as a separate Node process during `pnpm dev`.
 *
 * Per enabled `telegram_account`, spawns a continuous long-poll loop that
 * calls `pollOnce` (which calls `getUpdates` with a ~25s timeout). Errors
 * back off with progressive sleep; 409 Conflict surfaces in
 * `telegram_accounts.last_poll_error` and the loop keeps retrying since
 * the conflicting poller may go away.
 *
 * Unlike the email worker we don't use pg-boss queueing here — Telegram's
 * long-poll model is already a single-flight per token, so wrapping it in
 * a job queue would just add latency. Single worker instance is assumed
 * for v1; multi-instance would need an advisory lock per account.
 *
 * Env loading via `--env-file-if-exists=.env.local` in package.json.
 */
import { eq } from 'drizzle-orm';
import { db, telegramAccounts, type TelegramAccount } from '@mantle/db';
import { pollOnce, evictBot } from '@mantle/telegram';

const ACCOUNT_REFRESH_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/** Active per-account loops keyed by account id. */
const loops = new Map<string, { stop: () => void }>();

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  if (!process.env.MANTLE_MASTER_KEY) throw new Error('MANTLE_MASTER_KEY must be set');

  console.log('[telegram-poll] worker up');
  await refreshAccounts();
  const interval = setInterval(refreshAccounts, ACCOUNT_REFRESH_MS);

  const shutdown = async () => {
    console.log('[telegram-poll] shutting down…');
    clearInterval(interval);
    for (const { stop } of loops.values()) stop();
    loops.clear();
    // Give in-flight getUpdates a moment to settle.
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function refreshAccounts(): Promise<void> {
  const accounts = await db
    .select()
    .from(telegramAccounts)
    .where(eq(telegramAccounts.enabled, true));
  const live = new Set(accounts.map((a) => a.id));

  for (const account of accounts) {
    if (!loops.has(account.id)) {
      console.log(`[telegram-poll] starting loop for @${account.botUsername}`);
      loops.set(account.id, startLoop(account));
    }
  }
  for (const [id, ctrl] of loops.entries()) {
    if (!live.has(id)) {
      console.log(`[telegram-poll] stopping loop for ${id}`);
      ctrl.stop();
      loops.delete(id);
      evictBot(id);
    }
  }
}

function startLoop(initial: TelegramAccount): { stop: () => void } {
  let stopped = false;
  let backoffMs = BACKOFF_BASE_MS;

  void (async () => {
    while (!stopped) {
      // Re-read the account from DB on each iteration so we pick up
      // offset updates from concurrent pollOnce calls (we have only
      // one, but this keeps lastUpdateOffset honest) and disable-flag
      // changes.
      //
      // Disable race: there's a ≤25s window between this check and
      // pollOnce returning where a disable via the UI won't take
      // effect — the long-poll completes, delivers any updates, then
      // the next iteration sees enabled=false and exits. Mild;
      // tolerating it lets pollOnce stay a simple async call.
      const [account] = await db
        .select()
        .from(telegramAccounts)
        .where(eq(telegramAccounts.id, initial.id))
        .limit(1);
      if (!account || !account.enabled) {
        console.log(`[telegram-poll] ${initial.id} disabled or removed, ending loop`);
        return;
      }
      try {
        const { delivered, updatesReceived } = await pollOnce(account, 25);
        if (updatesReceived > 0) {
          console.log(
            `[telegram-poll] @${account.botUsername} — ${updatesReceived} updates, ${delivered} delivered`,
          );
        }
        backoffMs = BACKOFF_BASE_MS;
      } catch (err) {
        console.error(`[telegram-poll] @${account.botUsername} error:`, err);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  })();

  return { stop: () => { stopped = true; } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
