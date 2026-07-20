/**
 * Maintenance worker — the nightly cron for schedulable registry sweeps
 * (docs/maintenance-runner.md, Phase 2). Mirrors the email/calendar worker
 * idiom: pg-boss queue + `boss.schedule` cron, one job per slot.
 *
 * Today the schedulable set is exactly one task: entities-dedupe (auto tier,
 * pure SQL). The sweep records every run into `maintenance_runs` (source
 * 'cron'), the same history the CLI and the /debug/integrity Maintenance tab
 * write to, and carries its own ~20h double-fire guard on top of pg-boss's
 * once-per-slot semantics.
 *
 * Cost-safety: sweeps are drawn from the registry's `schedulable` set, which
 * is asserted (registry + test) to be free, pure-SQL, recurring tasks only.
 * A model-spending task can never reach this worker.
 *
 * Env loading is handled by `--env-file-if-exists=.env.local` (dev) or the
 * container env (prod).
 */
import PgBoss from 'pg-boss';
import { waitForOwner } from '@mantle/db';
import { startProcessHeartbeat } from '@mantle/content';

import { reapStaleRuns } from '../lib/maintenance/history';
import { runScheduledSweeps } from '../lib/maintenance/sweeps';

const SWEEP_QUEUE = 'mantle.maintenance.sweep';
/** 03:30 UTC daily (pg-boss cron defaults to UTC; we pass tz explicitly so
 *  nobody has to know that) — off-peak everywhere we care about, and nothing
 *  here is timing-sensitive. */
const SWEEP_CRON = '30 3 * * *';

async function main() {
  // Liveness: touch a heartbeat file the compose healthcheck reads (catches a
  // WEDGED process; a dead one is already covered by the restart policy).
  startProcessHeartbeat();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');

  // Idles until the first account exists (fresh install), then resolves.
  const ownerId = await waitForOwner({ label: 'maintenance' });

  // Settle any run rows orphaned by a previous kill of this (or any) process.
  await reapStaleRuns().catch((err) =>
    console.error('[maintenance] stale-run reap failed (continuing):', err),
  );

  const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  boss.on('error', (err) => console.error('[pg-boss]', err));
  await boss.start();

  await boss.createQueue(SWEEP_QUEUE);
  await boss.schedule(SWEEP_QUEUE, SWEEP_CRON, undefined, { tz: 'UTC' });
  await boss.work(SWEEP_QUEUE, async () => {
    await runScheduledSweeps(ownerId);
  });

  console.log(`[maintenance] worker up — cron '${SWEEP_CRON}' (UTC) on ${SWEEP_QUEUE}`);

  const shutdown = async () => {
    console.log('[maintenance] shutting down…');
    await boss.stop({ graceful: true, timeout: 10_000 });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Backstop: sweep work is caught inside runScheduledSweeps and boss.on('error')
// covers the queue's own connection, but a rejection that slips past either
// should log and keep the worker alive rather than crash-loop on a transient
// PostgresError. Docker would bounce us anyway; staying up is strictly better.
process.on('unhandledRejection', (reason) => {
  console.error('[maintenance] unhandledRejection (kept alive):', reason);
});

main().catch((err) => {
  console.error('[maintenance] fatal:', err);
  process.exit(1);
});
