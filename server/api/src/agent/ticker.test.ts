import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLogSink } from '@mantle/tracing';
import { startTicker } from './ticker';

/**
 * The backoff these cases drive shipped twice, hand-written, inside a boot
 * function — which meant it had never been executed by a test. The bug it
 * guards against is not theoretical: a tick that fails forever at full rate is
 * how a flapping embeddings endpoint turns into a retry storm, and the reset
 * on recovery is the half that is easy to get wrong and impossible to notice,
 * because a permanently-backed-off ticker looks exactly like a quiet one.
 */
const logger = { log: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  logger.log.mockClear();
  logger.error.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  registerLogSink(null);
});

/** Advance timers and let the promise chain inside the tick settle. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('startTicker', () => {
  it('runs on each interval and not before the first one elapses', async () => {
    const run = vi.fn(async () => {});
    startTicker({ name: 't', everyMs: 1000, run, logger });

    await advance(999);
    expect(run).toHaveBeenCalledTimes(0);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(2000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('calls onSuccess only after a successful tick', async () => {
    const onSuccess = vi.fn();
    let fail = true;
    startTicker({
      name: 't',
      everyMs: 1000,
      backoffCapMs: 60_000,
      run: async () => {
        if (fail) throw new Error('boom');
      },
      onSuccess,
      logger,
    });

    await advance(1000);
    expect(onSuccess).not.toHaveBeenCalled();
    fail = false;
    await advance(1000);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  describe('with a backoff cap', () => {
    /**
     * Inherited quirk, pinned deliberately. The skip test is `Date.now() <
     * skipUntil`, and the FIRST failure sets `skipUntil` to exactly one
     * interval later — which is exactly when the next tick fires. So the first
     * backoff step skips nothing at all: real spacing only begins at the second
     * failure, when the doubling puts skipUntil past a tick boundary.
     *
     * This is what the two hand-written copies in startAgentRuntime did, and
     * changing it here would alter live retry timing under cover of a refactor.
     * It is recorded rather than fixed, so a later decision to make the first
     * step bite is a deliberate one with a failing test to update.
     */
    it('does not actually skip on the first failure (the boundary is inclusive)', async () => {
      const run = vi.fn(async () => {
        throw new Error('boom');
      });
      startTicker({ name: 't', everyMs: 1000, backoffCapMs: 60_000, run, logger });

      await advance(1000); // run #1 fails; backoff 1000, skipUntil 2000
      expect(run).toHaveBeenCalledTimes(1);
      await advance(1000); // t=2000: 2000 < 2000 is false, so it runs anyway
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('doubles from the second failure, so attempts land on powers of two', async () => {
      const run = vi.fn(async () => {
        throw new Error('boom');
      });
      startTicker({ name: 't', everyMs: 1000, backoffCapMs: 60_000, run, logger });

      await advance(2000); // runs at t=1000 and t=2000 (see above)
      expect(run).toHaveBeenCalledTimes(2); // backoff now 2000, skipUntil 4000

      await advance(1000); // t=3000 skipped
      expect(run).toHaveBeenCalledTimes(2);
      await advance(1000); // t=4000 runs; backoff 4000, skipUntil 8000
      expect(run).toHaveBeenCalledTimes(3);

      await advance(3000); // t=5000..7000 all skipped
      expect(run).toHaveBeenCalledTimes(3);
      await advance(1000); // t=8000 runs
      expect(run).toHaveBeenCalledTimes(4);
    });

    it('never waits longer than the cap', async () => {
      const run = vi.fn(async () => {
        throw new Error('boom');
      });
      startTicker({ name: 't', everyMs: 1000, backoffCapMs: 4000, run, logger });

      // Run long enough that an uncapped doubling would be far past 4s.
      await advance(60_000);
      const callsAfterFirstMinute = run.mock.calls.length;
      await advance(60_000);
      const secondMinute = run.mock.calls.length - callsAfterFirstMinute;

      // Capped at 4s means roughly a tick every 5s (skip until 4s after the
      // failure, then the next interval boundary). Well short of 60 and well
      // clear of the 1-2 an uncapped doubling would give.
      expect(secondMinute).toBeGreaterThanOrEqual(8);
      expect(secondMinute).toBeLessThanOrEqual(15);
    });

    it('resets the backoff on recovery, and says so once', async () => {
      let fail = true;
      const run = vi.fn(async () => {
        if (fail) throw new Error('boom');
      });
      startTicker({ name: 'reflector', everyMs: 1000, backoffCapMs: 60_000, run, logger });

      // Fail twice to build a real backoff: attempts at t=1000 and t=2000
      // leave backoff at 2000ms, so the next attempt is t=4000.
      await advance(2000);
      expect(run).toHaveBeenCalledTimes(2);

      fail = false;
      await advance(2000); // t=4000 runs and succeeds
      expect(run).toHaveBeenCalledTimes(3);
      expect(logger.log).toHaveBeenCalledWith('reflector recovered; clearing backoff');

      // Backoff cleared: ticks resume at the plain interval.
      const before = run.mock.calls.length;
      await advance(3000);
      expect(run.mock.calls.length - before).toBe(3);

      // "recovered" is not repeated while it keeps succeeding.
      expect(logger.log.mock.calls.filter(([m]) => String(m).includes('recovered'))).toHaveLength(
        1,
      );
    });

    it('reports the next attempt in its error line', async () => {
      startTicker({
        name: 'heartbeat tick',
        everyMs: 60_000,
        backoffCapMs: 30 * 60_000,
        run: async () => {
          throw new Error('db down');
        },
        logger,
      });
      await advance(60_000);
      expect(logger.error).toHaveBeenCalledWith(
        'heartbeat tick error (next try in 60s):',
        'db down',
      );
    });
  });

  describe('without a backoff cap', () => {
    it('keeps ticking at full rate and never skips', async () => {
      const run = vi.fn(async () => {
        throw new Error('boom');
      });
      startTicker({ name: 'extract sweep', everyMs: 1000, run, logger });

      await advance(5000);
      expect(run).toHaveBeenCalledTimes(5);
      expect(logger.error).toHaveBeenCalledWith(
        'extract sweep error (will retry next tick):',
        'boom',
      );
    });
  });

  it('stops ticking after stop(), idempotently', async () => {
    const run = vi.fn(async () => {});
    const ticker = startTicker({ name: 't', everyMs: 1000, run, logger });

    await advance(2000);
    expect(run).toHaveBeenCalledTimes(2);
    ticker.stop();
    ticker.stop();
    await advance(5000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  /**
   * The cases above inject a logger and therefore see UNPREFIXED messages.
   * That is deliberate — the ticker builds the message, the scoped logger owns
   * the `[agent] ` prefix — but it means none of them pins the line an operator
   * actually reads. This one does, through the real default path.
   */
  it('emits the [agent] prefix through the default logger', async () => {
    const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    registerLogSink(sink);
    startTicker({
      name: 'extract sweep',
      everyMs: 1000,
      run: async () => {
        throw new Error('boom');
      },
    });
    await advance(1000);
    expect(sink.error).toHaveBeenCalledWith(
      '[agent] extract sweep error (will retry next tick):',
      'boom',
    );
  });

  it('passes a non-Error rejection through as-is', async () => {
    startTicker({
      name: 't',
      everyMs: 1000,
      run: async () => {
        throw 'a bare string';
      },
      logger,
    });
    await advance(1000);
    expect(logger.error).toHaveBeenCalledWith('t error (will retry next tick):', 'a bare string');
  });
});
