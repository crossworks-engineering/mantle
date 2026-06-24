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
import { and, eq } from 'drizzle-orm';
import { db, msAccounts, msDrives } from '@mantle/db';
import { syncDrive } from '@mantle/microsoft';

const SYNC_QUEUE = 'mantle.microsoft.drive-sync';
const SCHEDULER_QUEUE = 'mantle.microsoft.scheduler';

interface DriveSyncJob {
  driveDbId: string;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');

  const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  boss.on('error', (err) => console.error('[pg-boss]', err));
  await boss.start();

  await boss.createQueue(SYNC_QUEUE);
  await boss.createQueue(SCHEDULER_QUEUE);

  // ── scheduler ────────────────────────────────────────────────────────
  await boss.schedule(SCHEDULER_QUEUE, '*/2 * * * *');
  await boss.work(SCHEDULER_QUEUE, async () => {
    const rows = await db
      .select({ id: msDrives.id })
      .from(msDrives)
      .innerJoin(msAccounts, eq(msDrives.accountId, msAccounts.id))
      .where(and(eq(msDrives.enabled, true), eq(msAccounts.enabled, true)));
    for (const r of rows) {
      await boss.send(SYNC_QUEUE, { driveDbId: r.id } satisfies DriveSyncJob, {
        singletonKey: `ms-drive:${r.id}`,
      });
    }
    console.log(`[ms-scheduler] queued ${rows.length} drive syncs`);
  });

  // ── sync worker ──────────────────────────────────────────────────────
  await boss.work<DriveSyncJob>(SYNC_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const [drive] = await db.select().from(msDrives).where(eq(msDrives.id, job.data.driveDbId)).limit(1);
      if (!drive || !drive.enabled) continue;
      const [account] = await db.select().from(msAccounts).where(eq(msAccounts.id, drive.accountId)).limit(1);
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

  console.log('[microsoft-sync] worker up. Queues:', [SYNC_QUEUE, SCHEDULER_QUEUE].join(', '));

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
