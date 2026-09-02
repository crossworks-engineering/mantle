/**
 * One periodic background tick, with optional failure backoff.
 *
 * `startAgentRuntime` hand-rolled this four times — reflector, heartbeat tick,
 * extract sweep, table migration sweep. Two of the four grew a backoff (a
 * failing tick used to retry forever at full rate when embeddings or
 * OpenRouter flapped) and two did not, and the two that did were
 * copy-of-a-copy: the same `let xBackoffMs / let xSkipUntil` pair, the same
 * doubling, the same reset, spelled out twice with different variable
 * prefixes. That is four chances to get the reset wrong and no way to test any
 * of them, because the state lived in closures inside a 100-line boot function.
 *
 * Extracting it does not make the runtime shorter for its own sake. It makes
 * the backoff a unit — see ticker.test.ts, which drives the doubling, the cap,
 * and the reset-on-success with fake timers. None of that was reachable before.
 *
 * ## Semantics are deliberately IDENTICAL to the code this replaced
 *
 * In particular a slow `run` can still overlap the next interval: the original
 * four had no in-flight guard, and adding one here would change production
 * timing behaviour under the cover of a refactor. If overlap turns out to
 * matter, that is its own change with its own reasoning.
 */

import { log } from '@mantle/tracing';

export type Ticker = {
  /** Stop the timer. Idempotent. An in-flight `run` is not cancelled — it
   *  settles on its own, exactly as it did before. */
  stop(): void;
};

export type TickerOpts<T> = {
  /** Log prefix, e.g. 'reflector'. Appears in every line this emits. */
  name: string;
  /** Interval between ticks, and the FIRST backoff step after a failure. */
  everyMs: number;
  /**
   * Ceiling for the doubling backoff. Omit for no backoff at all: a failing
   * tick logs and the next interval runs as usual (what the two sweeps do).
   */
  backoffCapMs?: number;
  /** The work. Rejections drive the backoff; they never escape. */
  run: () => Promise<T>;
  /**
   * Extra reporting on a successful tick, e.g. the heartbeat counts line.
   * Receives THIS tick's result rather than reading a shared variable: ticks
   * may overlap (see above), so a stashed "last report" could be another
   * tick's by the time this runs.
   */
  onSuccess?: (result: T) => void;
  /** Injected for tests. Defaults to console. */
  logger?: { log: (msg: string) => void; error: (msg: string, err: unknown) => void };
};

// Messages here are built WITHOUT a prefix; the scoped logger adds `[agent] `,
// so a tick's lines read exactly as they did as console calls and now reach
// DBOS.logger in the runner along with everything else.
const scoped = log('agent');
const defaultLogger = {
  log: (msg: string) => scoped.info(msg),
  error: (msg: string, err: unknown) => scoped.error(msg, err),
};

/** The message half of an error, matching what the four call sites logged. */
function reasonOf(err: unknown): unknown {
  return err instanceof Error ? err.message : err;
}

export function startTicker<T>(opts: TickerOpts<T>): Ticker {
  const { name, everyMs, backoffCapMs, run, onSuccess } = opts;
  const logger = opts.logger ?? defaultLogger;

  // Backoff state, previously a pair of `let`s per call site.
  let backoffMs = 0;
  let skipUntil = 0;

  const timer = setInterval(() => {
    if (Date.now() < skipUntil) return;
    run()
      .then((result) => {
        if (backoffMs > 0) logger.log(`${name} recovered; clearing backoff`);
        backoffMs = 0;
        skipUntil = 0;
        onSuccess?.(result);
      })
      .catch((err: unknown) => {
        if (backoffCapMs === undefined) {
          logger.error(`${name} error (will retry next tick):`, reasonOf(err));
          return;
        }
        // First failure waits one interval; every one after that doubles,
        // capped. A success resets both, above.
        backoffMs = Math.min(backoffCapMs, backoffMs === 0 ? everyMs : backoffMs * 2);
        skipUntil = Date.now() + backoffMs;
        logger.error(
          `${name} error (next try in ${Math.round(backoffMs / 1000)}s):`,
          reasonOf(err),
        );
      });
  }, everyMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
