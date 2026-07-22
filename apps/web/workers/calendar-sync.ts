/**
 * Calendar-sync worker — mirrors workers/email-sync.ts / microsoft-sync.ts.
 *
 * Two queues:
 *   - mantle.calendar.sync       — single-flight per-calendar incremental sync
 *   - mantle.calendar.scheduler  — fan-out: one sync per enabled calendar, /2min
 *
 * `singletonKey: calendar:<id>` collapses concurrent ticks for one calendar.
 */
import { PgBoss } from 'pg-boss';
import { eq } from 'drizzle-orm';
import { calendarAccounts, db } from '@mantle/db';
import { syncCalendarAccount } from '@mantle/calendar';
import { startProcessHeartbeat } from '@mantle/content';

const SYNC_QUEUE = 'mantle.calendar.sync';
const SCHEDULER_QUEUE = 'mantle.calendar.scheduler';

interface CalSyncJob {
  accountId: string;
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
  await boss.createQueue(SCHEDULER_QUEUE);

  // ── scheduler ────────────────────────────────────────────────────────
  await boss.schedule(SCHEDULER_QUEUE, '*/2 * * * *');
  await boss.work(SCHEDULER_QUEUE, async () => {
    const accounts = await db
      .select({ id: calendarAccounts.id })
      .from(calendarAccounts)
      .where(eq(calendarAccounts.enabled, true));
    for (const a of accounts) {
      await boss.send(SYNC_QUEUE, { accountId: a.id } satisfies CalSyncJob, {
        singletonKey: `calendar:${a.id}`,
      });
    }
    console.log(`[cal-scheduler] queued ${accounts.length} calendar syncs`);
  });

  // ── sync worker ──────────────────────────────────────────────────────
  await boss.work<CalSyncJob>(SYNC_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const [account] = await db
        .select()
        .from(calendarAccounts)
        .where(eq(calendarAccounts.id, job.data.accountId))
        .limit(1);
      if (!account || !account.enabled) continue;

      try {
        const t0 = Date.now();
        const { pulled, upserted, removed } = await syncCalendarAccount(account);
        console.log(
          `[cal-sync] ${account.displayName} done in ${Date.now() - t0}ms — pulled=${pulled} upserted=${upserted} removed=${removed}`,
        );
      } catch (err) {
        console.error('[cal-sync] error on', account.displayName, err);
        await db
          .update(calendarAccounts)
          .set({
            lastSyncError: String((err as Error).message).slice(0, 500),
            updatedAt: new Date(),
          })
          .where(eq(calendarAccounts.id, account.id))
          .catch(() => {});
        throw err; // let pg-boss record failure + retry
      }
    }
  });

  console.log('[calendar-sync] worker up. Queues:', [SYNC_QUEUE, SCHEDULER_QUEUE].join(', '));

  const shutdown = async () => {
    console.log('[calendar-sync] shutting down…');
    await boss.stop({ graceful: true, timeout: 10_000 });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

process.on('unhandledRejection', (reason) => {
  console.error('[calendar-sync] unhandledRejection (kept alive):', reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
