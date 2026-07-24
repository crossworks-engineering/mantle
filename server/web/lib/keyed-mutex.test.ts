import { describe, expect, it } from 'vitest';
import { withKeyedLock } from './keyed-mutex';

/** A deferred promise for orchestrating interleavings without timers. */
function defer<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('withKeyedLock', () => {
  it('serializes runs sharing a key (no overlap)', async () => {
    const events: string[] = [];
    const aStarted = defer();
    const releaseA = defer();
    const bStarted = defer();
    const releaseB = defer();

    const a = withKeyedLock('k', async () => {
      events.push('a:start');
      aStarted.resolve();
      await releaseA.promise;
      events.push('a:end');
    });
    const b = withKeyedLock('k', async () => {
      events.push('b:start');
      bStarted.resolve();
      await releaseB.promise;
      events.push('b:end');
    });

    await aStarted.promise;
    // b is queued behind a and must not have started while a holds the lock.
    expect(events).toEqual(['a:start']);
    releaseA.resolve();
    await bStarted.promise;
    expect(events).toEqual(['a:start', 'a:end', 'b:start']);
    releaseB.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('runs different keys concurrently', async () => {
    const events: string[] = [];
    const aStarted = defer();
    const releaseA = defer();
    const a = withKeyedLock('k1', async () => {
      events.push('a:start');
      aStarted.resolve();
      await releaseA.promise;
    });
    await aStarted.promise; // a holds k1 and is parked
    // b under a DIFFERENT key completes without waiting for a to release.
    await withKeyedLock('k2', async () => {
      events.push('b:start');
    });
    expect(events).toEqual(['a:start', 'b:start']);
    releaseA.resolve();
    await a;
  });

  it('a throwing run does not wedge the key — the next contender still runs', async () => {
    await expect(
      withKeyedLock('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const result = await withKeyedLock('k', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('returns the run’s value', async () => {
    await expect(withKeyedLock('k', async () => 42)).resolves.toBe(42);
  });
});
