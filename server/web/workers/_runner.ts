/**
 * The shell every worker in this directory was writing out by hand.
 *
 * Each one opened the same way — touch the heartbeat file, demand
 * DATABASE_URL, build a PgBoss, wire SIGINT/SIGTERM, swallow unhandled
 * rejections, `main().catch(exit 1)` — and only then did anything specific to
 * its job. Two thirds of calendar-sync's code was byte-identical to
 * microsoft-sync's, and the copies had drifted where it matters least visibly:
 * one worker exits synchronously on a signal, two exit from a `setTimeout`, and
 * NONE of them bounded how long shutdown may take, so a wedged `boss.stop()`
 * left a container that looked alive and did nothing until Docker's grace
 * period ran out.
 *
 * Two entry points, because the fleet genuinely has two shapes:
 *
 *   runQueueWorker  the five pg-boss workers — a queue is created, scheduled
 *                   and worked; the runner owns the boss lifecycle.
 *   runWorker       the five that own their own loop (interval tick, file
 *                   watcher, long poll) and just need the process shell.
 *
 * Both take a setup that may return a teardown, which runs before the runner
 * releases anything it owns.
 */
import { PgBoss } from 'pg-boss';
import { startProcessHeartbeat } from '@mantle/content';

/** How long pg-boss may take to finish in-flight jobs. */
const BOSS_STOP_TIMEOUT_MS = 10_000;

/**
 * Hard ceiling on shutdown. Docker SIGKILLs after its own grace period anyway,
 * so a teardown that outlives this has already failed — exiting non-zero says
 * so, where hanging just looks like a healthy container doing nothing.
 */
const EXIT_DEADLINE_MS = 15_000;

/** Released before the runner tears down what it owns. */
export type Teardown = () => void | Promise<void>;

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  return url;
}

/**
 * Boot `start`, then hold the process open until a signal arrives.
 *
 * Signal handlers are installed BEFORE booting, so a SIGTERM during a slow
 * start still exits instead of being ignored until setup finishes.
 */
function run(name: string, start: () => Promise<void>, stop: () => Promise<void>): void {
  let stopping = false;

  /**
   * Hold the event loop open for as long as the worker is meant to be running.
   *
   * Every worker happens to own a handle that would do this — a timer, a
   * watcher, a LISTEN connection, a pg-boss pool — but relying on that makes
   * "stays up" an accident of what setup created. The heartbeat timer is
   * `unref()`d and process signal listeners don't count, so a worker whose one
   * handle went away would exit silently, healthy-looking and doing nothing.
   */
  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return; // a second signal must not race the first
    stopping = true;
    clearInterval(keepAlive);
    console.log(`[${name}] ${signal} — shutting down…`);
    const deadline = setTimeout(() => {
      console.error(`[${name}] shutdown exceeded ${EXIT_DEADLINE_MS}ms — exiting anyway`);
      process.exit(1);
    }, EXIT_DEADLINE_MS);
    try {
      await stop();
    } catch (err) {
      console.error(`[${name}] shutdown failed:`, err);
    }
    clearTimeout(deadline);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A stray rejection must not take the worker down: Docker would restart it,
  // and staying up is strictly better than a restart loop.
  process.on('unhandledRejection', (reason) => {
    console.error(`[${name}] unhandledRejection (kept alive):`, reason);
  });

  start()
    .then(() => console.log(`[${name}] worker up.`))
    .catch((err) => {
      clearInterval(keepAlive);
      console.error(`[${name}] failed to start:`, err);
      process.exit(1);
    });
}

/**
 * A started PgBoss, wired to log its own connection errors.
 *
 * `runQueueWorker` uses this and owns the result. It is exported for the one
 * worker that cannot: `runs` idles WITHOUT a queue when MANTLE_RUNS is off
 * (heartbeat still ticking so the healthcheck stays green), so it must decide
 * whether to connect at all. Stop it from the teardown you return.
 */
export async function createBoss(name: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: databaseUrl(), schema: 'pgboss' });
  boss.on('error', (err) => console.error(`[${name}] pg-boss:`, err));
  await boss.start();
  return boss;
}

/** Stop a boss the way the runner would. */
export function stopBoss(boss: PgBoss): Promise<void> {
  return boss.stop({ graceful: true, timeout: BOSS_STOP_TIMEOUT_MS });
}

/** Run a pg-boss-backed worker. The boss is started before `setup` and stopped
 *  gracefully on shutdown; `setup` creates queues, schedules and workers. */
export function runQueueWorker(
  name: string,
  setup: (ctx: { boss: PgBoss }) => Promise<Teardown | void>,
): void {
  let boss: PgBoss | null = null;
  let teardown: Teardown | void;

  run(
    name,
    async () => {
      // Liveness: touch a heartbeat file the compose healthcheck reads (catches
      // a WEDGED process; a dead one is already covered by the restart policy).
      startProcessHeartbeat();
      boss = await createBoss(name);
      teardown = await setup({ boss });
    },
    async () => {
      await teardown?.();
      if (boss) await stopBoss(boss);
    },
  );
}

/** Run a worker that drives its own loop — an interval, a watcher, a long
 *  poll. It gets the process shell and nothing else; whatever it returns is
 *  called on shutdown. */
export function runWorker(name: string, setup: () => Promise<Teardown | void>): void {
  let teardown: Teardown | void;

  run(
    name,
    async () => {
      startProcessHeartbeat();
      databaseUrl(); // fail fast and identically, even without a boss
      teardown = await setup();
    },
    async () => {
      await teardown?.();
    },
  );
}
