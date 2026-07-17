/**
 * Microsoft drive-sync worker — mirrors workers/email-sync.ts.
 *
 * Two queues:
 *   - mantle.microsoft.drive-sync  — single-flight per-drive incremental sync
 *   - mantle.microsoft.scheduler   — fan-out: enqueue a sync for every enabled
 *                                     drive on an enabled account, every 2 min
 *
 * `singletonKey: ms-drive:<id>` collapses concurrent ticks for one drive.
 * Discovery (listing drives) is user-triggered from the settings UI, not here.
 */
import PgBoss from 'pg-boss';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, emailAccounts, msAccounts, msDrives } from '@mantle/db';
import { graphMailProvider, syncDrive } from '@mantle/microsoft';
import { syncAccount } from '@mantle/email';
import { startProcessHeartbeat } from '@mantle/content';

const SYNC_QUEUE = 'mantle.microsoft.drive-sync';
const MAIL_QUEUE = 'mantle.microsoft.mail-sync';
const SCHEDULER_QUEUE = 'mantle.microsoft.scheduler';

interface DriveSyncJob {
  driveDbId: string;
}

interface MailSyncJob {
  emailAccountId: string;
}

async function main() {
  // Liveness: touch a heartbeat file the compose healthcheck reads (catches a
  // WEDGED process; a dead one is already covered by the restart policy).
  startProcessHeartbeat();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');

  const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  boss.on('error', (err) => console.error('[pg-boss]', err));
  await boss.start();

  await boss.createQueue(SYNC_QUEUE);
  await boss.createQueue(MAIL_QUEUE);
  await boss.createQueue(SCHEDULER_QUEUE);

  // ── scheduler ────────────────────────────────────────────────────────
  // Fans out both drive syncs and mail syncs every 2 minutes.
  await boss.schedule(SCHEDULER_QUEUE, '*/2 * * * *');
  await boss.work(SCHEDULER_QUEUE, async () => {
    const drives = await db
      .select({ id: msDrives.id })
      .from(msDrives)
      .innerJoin(msAccounts, eq(msDrives.accountId, msAccounts.id))
      .where(and(eq(msDrives.enabled, true), eq(msAccounts.enabled, true)));
    for (const r of drives) {
      await boss.send(SYNC_QUEUE, { driveDbId: r.id } satisfies DriveSyncJob, {
        singletonKey: `ms-drive:${r.id}`,
      });
    }

    // Companion mailbox accounts (provider='microsoft', linked to an ms_account).
    const mailboxes = await db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(
        and(
          eq(emailAccounts.provider, 'microsoft'),
          eq(emailAccounts.enabled, true),
          isNotNull(emailAccounts.msAccountId),
        ),
      );
    for (const m of mailboxes) {
      await boss.send(MAIL_QUEUE, { emailAccountId: m.id } satisfies MailSyncJob, {
        singletonKey: `ms-mail:${m.id}`,
      });
    }

    console.log(`[ms-scheduler] queued ${drives.length} drive + ${mailboxes.length} mail syncs`);
  });

  // ── sync worker ──────────────────────────────────────────────────────
  await boss.work<DriveSyncJob>(SYNC_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const [drive] = await db
        .select()
        .from(msDrives)
        .where(eq(msDrives.id, job.data.driveDbId))
        .limit(1);
      if (!drive || !drive.enabled) continue;
      const [account] = await db
        .select()
        .from(msAccounts)
        .where(eq(msAccounts.id, drive.accountId))
        .limit(1);
      if (!account || !account.enabled) continue;

      try {
        const t0 = Date.now();
        const { scanned, ingested, removed } = await syncDrive(account, drive);
        console.log(
          `[ms-sync] ${drive.name} done in ${Date.now() - t0}ms — scanned=${scanned} ingested=${ingested} removed=${removed}`,
        );
      } catch (err) {
        console.error('[ms-sync] error on', drive.name, err);
        await db
          .update(msDrives)
          .set({ lastError: String((err as Error).message).slice(0, 500), updatedAt: new Date() })
          .where(eq(msDrives.id, drive.id))
          .catch(() => {});
        throw err; // let pg-boss record failure + retry
      }
    }
  });

  // ── mail worker ──────────────────────────────────────────────────────
  // Reuses the email pipeline wholesale: syncAccount applies the contact gate,
  // classifies, and inserts node + emails row + attachments via the Graph
  // provider. Mail respects the SAME contact gate as IMAP (only approved
  // senders ingested).
  await boss.work<MailSyncJob>(MAIL_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const [account] = await db
        .select()
        .from(emailAccounts)
        .where(eq(emailAccounts.id, job.data.emailAccountId))
        .limit(1);
      if (!account || !account.enabled || account.provider !== 'microsoft') continue;

      try {
        const t0 = Date.now();
        const { scanned, ingested } = await syncAccount(account, graphMailProvider);
        console.log(
          `[ms-mail] ${account.address} done in ${Date.now() - t0}ms — scanned=${scanned} ingested=${ingested}`,
        );
      } catch (err) {
        console.error('[ms-mail] error on', account.address, err);
        throw err; // syncAccount already recorded lastSyncError; let pg-boss retry
      }
    }
  });

  console.log(
    '[microsoft-sync] worker up. Queues:',
    [SYNC_QUEUE, MAIL_QUEUE, SCHEDULER_QUEUE].join(', '),
  );

  const shutdown = async () => {
    console.log('[microsoft-sync] shutting down…');
    await boss.stop({ graceful: true, timeout: 10_000 });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

process.on('unhandledRejection', (reason) => {
  console.error('[microsoft-sync] unhandledRejection (kept alive):', reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
