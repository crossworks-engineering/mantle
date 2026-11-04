/**
 * Maintenance worker — the nightly cron for schedulable registry sweeps
 * (docs/maintenance-runner.md). Mirrors the email/calendar worker
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
import { feature } from '@mantle/config';
import { waitForOwner } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { runDueAppTimers } from '@mantle/tools';
import { log } from '@mantle/tracing';

import { installBoxStatusProvider } from '../lib/box-status';
import { reapStaleRuns } from '../lib/maintenance/history';
import { runScheduledSweeps } from '../lib/maintenance/sweeps';
import { runQueueWorker } from './_runner';

const SWEEP_QUEUE = 'mantle.maintenance.sweep';
/** 03:30 UTC daily (pg-boss cron defaults to UTC; we pass tz explicitly so
 *  nobody has to know that) — off-peak everywhere we care about, and nothing
 *  here is timing-sensitive. */
const SWEEP_CRON = '30 3 * * *';

/**
 * The app timers' tick (docs/app-timers.md): every minute, the due timers
 * of every app run, each its declared read-only tool as the login that set
 * it (@mantle/tools app-timers). No model work: the timer rule admits only
 * tools that read and spend nothing. pg-boss makes one job per minute for
 * the whole box (its schedule is one row, whichever replica keeps it), and
 * the claim (FOR UPDATE SKIP LOCKED) keeps two ticks that overlap, on one
 * replica or two, from running one timer twice. MANTLE_APP_TIMERS=0 (the
 * appTimers feature) is the box's kill switch: the tick runs no timer and
 * says so once; the nightly sweeps go on.
 */
const TIMER_QUEUE = 'mantle.app-timers.tick';
const TIMER_CRON = '* * * * *';
/** Whether the switched-off tick has said so (once per process). */
let timersOffSaid = false;

// The box status collector (box_status, peer_status's own line), as the web
// process installs it (server/main.ts): a timer that calls peer_status or
// box_status runs here, and without it the box's own line read
// `unavailable`. The reads run as the web's do, on the narrow route after
// the settings area check (builtins-box-status.ts ownStatus); this process
// has its own 30 second cache. maintenance-box-status.db.test.ts pins it.
installBoxStatusProvider();

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

  await boss.createQueue(TIMER_QUEUE);
  await boss.schedule(TIMER_QUEUE, TIMER_CRON, undefined, { tz: 'UTC' });
  await boss.work(TIMER_QUEUE, async () => {
    if (!feature('appTimers')) {
      if (!timersOffSaid) {
        timersOffSaid = true;
        log('maintenance').warn('app timers are switched off (MANTLE_APP_TIMERS): no timer runs');
      }
      return;
    }
    try {
      const t = await runDueAppTimers();
      if (t.claimed) {
        log('maintenance').info(`app timers: ${t.claimed} run, ${t.ok} ok, ${t.failed} failed`);
      }
    } catch (err) {
      // The claim or the database is down: the next minute tries again.
      log('maintenance').error(`app timers tick failed: ${errorMessage(err)}`);
    }
  });

  console.log(`[maintenance] cron '${SWEEP_CRON}' (UTC) on ${SWEEP_QUEUE}`);
  log('maintenance').info(`app timers '${TIMER_CRON}' (UTC) on ${TIMER_QUEUE}`);
});
