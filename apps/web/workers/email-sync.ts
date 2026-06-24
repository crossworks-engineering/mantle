/**
 * Email-sync worker. Runs as a separate Node process during `pnpm dev`.
 *
 * Three queues:
 *   - mantle.email.sync       — single-flight per-account incremental sync
 *   - mantle.email.backfill   — per-sender 90-day backfill when a sender is approved
 *   - mantle.email.scheduler  — fan-out: enqueues a `sync` job for every enabled account
 *
 * The scheduler is itself a recurring pg-boss job (every 2 minutes). The
 * sync queue uses `singletonKey: accountId` so two ticks can't stomp on
 * each other.
 *
 * Env loading is handled by Node's `--env-file-if-exists=.env.local` flag.
 */
import PgBoss from 'pg-boss';
import { and, eq } from 'drizzle-orm';
import { BACKFILL_QUEUE, backfillMatch, imap, syncAccount } from '@mantle/email';
import { db, emailAccounts } from '@mantle/db';

const SYNC_QUEUE = 'mantle.email.sync';
const SCHEDULER_QUEUE = 'mantle.email.scheduler';

import { maskEmail } from './mask-email';

interface SyncJob {
  accountId: string;
}

interface BackfillJob {
  accountId: string;
  /** A contact email entry to backfill from: a full address (`alex@x.com`)
   *  or a bare domain (`x.com`, from an `@domain` wildcard). */
  target: string;
}

function pickProvider(provider: 'imap' | 'gmail' | 'microsoft') {
  if (provider === 'imap') return imap;
  // The `email_provider` enum still includes 'gmail' and 'microsoft' for
  // historical reasons (we shipped OAuth then ripped it out — IMAP works
  // for both providers with app passwords). If you see this error, that
  // means a row in email_accounts somehow got a non-imap provider value.
  throw new Error(
    `Unsupported provider: '${provider}'. Mantle uses IMAP for everything; ` +
      `connect Gmail and Outlook via app passwords through Add IMAP.`,
  );
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');

  const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  boss.on('error', (err) => console.error('[pg-boss]', err));
  await boss.start();

  await boss.createQueue(SYNC_QUEUE);
  await boss.createQueue(BACKFILL_QUEUE);
  await boss.createQueue(SCHEDULER_QUEUE);

  // ── scheduler ────────────────────────────────────────────────────────
  // Fan-out: every 2 minutes, enqueue a sync job for each enabled account.
  await boss.schedule(SCHEDULER_QUEUE, '*/2 * * * *');
  await boss.work(SCHEDULER_QUEUE, async () => {
    // IMAP only — `provider='microsoft'` companion accounts are synced by the
    // microsoft-sync worker via Graph (see workers/microsoft-sync.ts).
    const accounts = await db
      .select({ id: emailAccounts.id, provider: emailAccounts.provider })
      .from(emailAccounts)
      .where(and(eq(emailAccounts.enabled, true), eq(emailAccounts.provider, 'imap')));
    for (const a of accounts) {
      // singletonKey collapses concurrent enqueues for the same account.
      await boss.send(SYNC_QUEUE, { accountId: a.id } satisfies SyncJob, {
        singletonKey: `sync:${a.id}`,
      });
    }
    console.log(`[scheduler] queued ${accounts.length} sync jobs`);
  });

  // ── sync worker ──────────────────────────────────────────────────────
  await boss.work<SyncJob>(SYNC_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const [account] = await db
        .select()
        .from(emailAccounts)
        .where(eq(emailAccounts.id, job.data.accountId))
        .limit(1);
      if (!account || !account.enabled) {
        console.log('[sync] skip', job.data.accountId, 'disabled or missing');
        continue;
      }
      // Safety net: microsoft companion accounts are handled by the microsoft
      // worker; never let one reach the IMAP-only pickProvider.
      if (account.provider !== 'imap') continue;
      const provider = pickProvider(account.provider);
      try {
        const t0 = Date.now();
        const { scanned, ingested } = await syncAccount(account, provider);
        console.log(
          `[sync] ${maskEmail(account.address)} done in ${Date.now() - t0}ms — scanned=${scanned} ingested=${ingested}`,
        );
      } catch (err) {
        console.error('[sync] error on', maskEmail(account.address), err);
        throw err; // let pg-boss record failure + retry
      }
    }
  });

  // ── backfill worker ──────────────────────────────────────────────────
  await boss.work<BackfillJob>(BACKFILL_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const [account] = await db
        .select()
        .from(emailAccounts)
        .where(eq(emailAccounts.id, job.data.accountId))
        .limit(1);
      if (!account) continue;
      // IMAP-only path; microsoft companion accounts ingest via the microsoft
      // worker (sender-approval backfill for them is not wired yet — new mail
      // still flows through the watermark sync).
      if (account.provider !== 'imap') continue;
      const provider = pickProvider(account.provider);
      try {
        const t0 = Date.now();
        const { ingested } = await backfillMatch(account, provider, job.data.target);
        console.log(
          `[backfill] ${maskEmail(account.address)} ← ${maskEmail(job.data.target)}: ingested ${ingested} in ${Date.now() - t0}ms`,
        );
      } catch (err) {
        console.error('[backfill] error', err);
        throw err;
      }
    }
  });

  console.log('[email-sync] worker up. Queues:', [SYNC_QUEUE, BACKFILL_QUEUE, SCHEDULER_QUEUE].join(', '));

  const shutdown = async () => {
    console.log('[email-sync] shutting down…');
    await boss.stop({ graceful: true, timeout: 10_000 });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Backstop: DB-touching work runs inside pg-boss handlers (which catch +
// retry) and boss.on('error') covers the queue's own connection, but a
// rejection that slips past either should log and keep the worker alive
// rather than crash-loop on a transient PostgresError. Docker would bounce
// us anyway; staying up is strictly better.
process.on('unhandledRejection', (reason) => {
  console.error('[email-sync] unhandledRejection (kept alive):', reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
