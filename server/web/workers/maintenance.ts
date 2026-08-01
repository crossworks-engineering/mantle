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
import { waitForOwner } from '@mantle/db';

import { reapStaleRuns } from '../lib/maintenance/history';
import { runScheduledSweeps } from '../lib/maintenance/sweeps';
import { runQueueWorker } from './_runner';

const SWEEP_QUEUE = 'mantle.maintenance.sweep';
/** 03:30 UTC daily (pg-boss cron defaults to UTC; we pass tz explicitly so
 *  nobody has to know that) — off-peak everywhere we care about, and nothing
 *  here is timing-sensitive. */
const SWEEP_CRON = '30 3 * * *';

runQueueWorker('maintenance', async ({ boss }) => {
  // Idles until the first account exists (fresh install), then resolves.
  const ownerId = await waitForOwner({ label: 'maintenance' });

  // Settle any run rows orphaned by a previous kill of this (or any) process.
  await reapStaleRuns().catch((err) =>
    console.error('[maintenance] stale-run reap failed (continuing):', err),
  );

  await boss.createQueue(SWEEP_QUEUE);
  await boss.schedule(SWEEP_QUEUE, SWEEP_CRON, undefined, { tz: 'UTC' });
  await boss.work(SWEEP_QUEUE, async () => {
    await runScheduledSweeps(ownerId);
  });

  console.log(`[maintenance] cron '${SWEEP_CRON}' (UTC) on ${SWEEP_QUEUE}`);
});
