/**
 * The app timers' scheduler tick (docs/app-timers.md): the maintenance
 * worker runs it every minute (server/web/workers/maintenance.ts). System
 * work, outside every scope.
 *
 * A tick runs APP_TIMER_CONCURRENCY lanes. Each lane, after a short random
 * delay (so a hundred timers set together do not fire in the same second),
 * claims ONE due timer right before it runs it (claimNextDueAppTimer: FOR
 * UPDATE SKIP LOCKED, and a claim no other tick, on this replica or
 * another, passes while it is live), runs it within its deadline
 * (runAppTimer) and writes its outcome under its claim
 * (finishAppTimerRun), then claims the next. A lane claims nothing new
 * after APP_TIMER_TICK_BUDGET_MS, so a tick ends within that plus one run
 * (about 2 minutes), and a claim never waits behind other runs: its run
 * starts at once, well inside the claim's 5 minutes.
 *
 * Capacity: 4 lanes for 45 s. With runs of about a second that is some 180
 * runs a minute, over the box's 100 timers at their 1-minute floor; with
 * every run at its 60 s deadline it is 4 a minute. A timer that falls
 * behind is not run twice to catch up: it is due, and runs when a lane
 * claims it. The floors keep the load down: 5 minutes for a timer a login
 * that is no Admin user set, 15 for an HTTP tool, so at most 20 timers of
 * the 100 can run every minute (an Admin user's own, per-login cap 20).
 */
import { errorMessage, sleep } from '@mantle/std';
import { log } from '@mantle/tracing';
import { runAppTimer, type AppTimerRunOpts } from './run';
import { appTimerIds, claimNextDueAppTimer, finishAppTimerRun } from './store';

/** Runs at once in one tick. */
export const APP_TIMER_CONCURRENCY = 4;
/** How long a tick's lanes claim new timers. */
export const APP_TIMER_TICK_BUDGET_MS = 45_000;
/** The most runs one tick makes (a backstop beside the budget). */
export const APP_TIMER_TICK_MAX = 200;
/** The longest random delay before a lane claims its next timer. */
export const APP_TIMER_START_JITTER_MS = 5_000;

/** What one tick did. */
export type AppTimerTick = { claimed: number; ok: number; failed: number };

/** What a tick may be told to do differently (tests). */
export type AppTimerTickOpts = AppTimerRunOpts & {
  max?: number;
  concurrency?: number;
  jitterMs?: number;
  budgetMs?: number;
  random?: () => number;
};

/** One tick: claim, run, record, a timer at a time per lane. Never throws
 *  for a run's sake. */
export async function runDueAppTimers(opts: AppTimerTickOpts = {}): Promise<AppTimerTick> {
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => new Date());
  const ends = Date.now() + (opts.budgetMs ?? APP_TIMER_TICK_BUDGET_MS);
  const max = opts.max ?? APP_TIMER_TICK_MAX;
  const out: AppTimerTick = { claimed: 0, ok: 0, failed: 0 };
  const lane = async () => {
    while (Date.now() < ends && out.claimed < max) {
      const jitter = Math.floor(random() * (opts.jitterMs ?? APP_TIMER_START_JITTER_MS));
      if (jitter > 0) await sleep(jitter);
      if (Date.now() >= ends || out.claimed >= max) return;
      const timer = await claimNextDueAppTimer();
      if (!timer) return;
      out.claimed += 1;
      try {
        const live = await appTimerIds(timer.appNodeId);
        const at = now();
        const res = await runAppTimer(timer, live, opts);
        await finishAppTimerRun(timer.id, timer.claimId!, {
          ranAt: at,
          ok: res.ok,
          ms: res.ms,
          error: res.error,
          minMinutes: res.minMinutes,
        });
        if (res.ok) out.ok += 1;
        else out.failed += 1;
      } catch (err) {
        // The claim stays: the timer is due again once it runs out.
        out.failed += 1;
        log('app-timers').warn(
          `timer ${timer.id}: the run was not recorded (${errorMessage(err)})`,
        );
      }
    }
  };
  const lanes = Math.max(1, opts.concurrency ?? APP_TIMER_CONCURRENCY);
  await Promise.all(Array.from({ length: lanes }, lane));
  return out;
}
