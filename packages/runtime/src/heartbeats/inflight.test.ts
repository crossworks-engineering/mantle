/**
 * Tests for the inflight lock — P0-2 from the v1 audit. The whole
 * point of this module is preventing a fire that takes longer than
 * the 60s tick interval from being double-fired by the next tick.
 * Pure in-process behaviour, easy to pin.
 */

import { describe, expect, it } from 'vitest';
import { isFireInflight, runWithInflightLock } from './inflight';

/** Tiny promise helper: resolve after `ms`, with the given value. */
function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((res) => setTimeout(() => res(value), ms));
}

describe('inflight — basic state', () => {
  it('returns false when no fire is running for the id', () => {
    expect(isFireInflight('unused-id')).toBe(false);
  });

  it("runWithInflightLock returns its function's value", async () => {
    const result = await runWithInflightLock('hb-1', async () => 42);
    expect(result).toBe(42);
  });

  it('clears the inflight marker after fn resolves', async () => {
    await runWithInflightLock('hb-2', async () => 'done');
    expect(isFireInflight('hb-2')).toBe(false);
  });

  it('clears the inflight marker after fn throws', async () => {
    await expect(
      runWithInflightLock('hb-3', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Critical: the lock MUST release even on error, otherwise the
    // heartbeat would be permanently invisible to the tick loop.
    expect(isFireInflight('hb-3')).toBe(false);
  });
});

describe('inflight — mid-flight visibility', () => {
  it('isFireInflight returns true while fn is running', async () => {
    let snapshotInside = false;
    const run = runWithInflightLock('hb-mid', async () => {
      snapshotInside = isFireInflight('hb-mid');
      await delay(20, null);
    });
    await run;
    expect(snapshotInside).toBe(true);
    // Cleared after.
    expect(isFireInflight('hb-mid')).toBe(false);
  });

  it('isFireInflight is scoped per id (different id stays false)', async () => {
    let other = true;
    const run = runWithInflightLock('hb-A', async () => {
      other = isFireInflight('hb-B');
      await delay(10, null);
    });
    await run;
    expect(other).toBe(false);
  });
});

describe('inflight — serialisation under contention', () => {
  it('two concurrent calls for the same id run sequentially, not in parallel', async () => {
    // Track entry + exit times so we can assert no overlap.
    const events: Array<{ id: string; phase: 'enter' | 'exit'; t: number }> = [];
    const start = Date.now();
    const record = (id: string, phase: 'enter' | 'exit') =>
      events.push({ id, phase, t: Date.now() - start });

    const fn = async () => {
      record('A', 'enter');
      await delay(25, null);
      record('A', 'exit');
    };
    const gn = async () => {
      record('B', 'enter');
      await delay(25, null);
      record('B', 'exit');
    };

    // Same id — should serialise.
    await Promise.all([runWithInflightLock('hb-same', fn), runWithInflightLock('hb-same', gn)]);

    // The exit of the first MUST come before the enter of the second.
    // Without this, parallelism slipped through and the lock failed.
    const exitA = events.find((e) => e.id === 'A' && e.phase === 'exit');
    const enterB = events.find((e) => e.id === 'B' && e.phase === 'enter');
    expect(exitA).toBeTruthy();
    expect(enterB).toBeTruthy();
    expect(enterB!.t).toBeGreaterThanOrEqual(exitA!.t);
  });

  it('concurrent calls for DIFFERENT ids run in parallel', async () => {
    // Belt-and-suspenders: the lock is per-id, so two different
    // heartbeats firing simultaneously is fine. If we accidentally
    // serialised across ids, throughput would tank.
    const events: Array<{ id: string; phase: 'enter' | 'exit'; t: number }> = [];
    const start = Date.now();
    const make = (id: string) => async () => {
      events.push({ id, phase: 'enter', t: Date.now() - start });
      await delay(25, null);
      events.push({ id, phase: 'exit', t: Date.now() - start });
    };

    await Promise.all([
      runWithInflightLock('hb-X', make('X')),
      runWithInflightLock('hb-Y', make('Y')),
    ]);

    // Both should have entered before either exited (true parallelism).
    const enterX = events.find((e) => e.id === 'X' && e.phase === 'enter');
    const enterY = events.find((e) => e.id === 'Y' && e.phase === 'enter');
    const exitX = events.find((e) => e.id === 'X' && e.phase === 'exit');
    const exitY = events.find((e) => e.id === 'Y' && e.phase === 'exit');
    expect(enterX).toBeTruthy();
    expect(enterY).toBeTruthy();
    // Both entered before either exited.
    expect(enterY!.t).toBeLessThan(exitX!.t);
    expect(enterX!.t).toBeLessThan(exitY!.t);
  });

  it('a failed first call does NOT prevent a queued second call from running', async () => {
    // Failure of A shouldn't poison the lock for B. The release in
    // the finally block is what makes this true.
    let bRan = false;
    const a = runWithInflightLock('hb-poison', async () => {
      throw new Error('A failed');
    }).catch(() => undefined);
    // B is queued behind A.
    const b = runWithInflightLock('hb-poison', async () => {
      bRan = true;
      return 'B done';
    });
    await Promise.all([a, b]);
    expect(bRan).toBe(true);
  });
});

describe('inflight — return-value passthrough', () => {
  it("returns the inner function's exact value (no wrapping)", async () => {
    const obj = { nested: { ok: true } };
    const r = await runWithInflightLock('hb-pass', async () => obj);
    expect(r).toBe(obj); // identity, not just equal
  });

  it("propagates the inner function's thrown error verbatim", async () => {
    class CustomError extends Error {
      readonly tag = 'custom';
    }
    await expect(
      runWithInflightLock('hb-err', async () => {
        throw new CustomError('specific message');
      }),
    ).rejects.toMatchObject({ tag: 'custom', message: 'specific message' });
  });
});
