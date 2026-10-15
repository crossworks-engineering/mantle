import { afterEach, describe, expect, it, vi } from 'vitest';
import { onShutdown } from './shutdown';

function fakeProcess() {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  return {
    listeners,
    exits,
    proc: {
      on: (s: string, l: () => void) => listeners.set(s, l),
      exit: (code: number) => {
        exits.push(code);
      },
    },
  };
}
const quiet = { info: () => undefined, error: () => undefined };

afterEach(() => {
  vi.useRealTimers();
});

describe('onShutdown (A10 #15: one shutdown helper with an exit deadline)', () => {
  it('installs SIGINT and SIGTERM, runs stop once, exits 0', async () => {
    const f = fakeProcess();
    const stop = vi.fn(async () => undefined);
    const shutdown = onShutdown({ name: 't', stop, deadlineMs: 1000, process: f.proc, log: quiet });
    expect([...f.listeners.keys()]).toEqual(['SIGINT', 'SIGTERM']);
    const first = shutdown('SIGTERM');
    // A second signal while stopping is ignored.
    await shutdown('SIGINT');
    await first;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('SIGTERM');
    expect(f.exits).toEqual([0]);
  });

  it('exits with the deadline code when stop outlives the deadline', async () => {
    vi.useFakeTimers();
    const f = fakeProcess();
    const lines: string[] = [];
    const shutdown = onShutdown({
      name: 'api',
      stop: () => new Promise<void>(() => undefined),
      deadlineMs: 45_000,
      process: f.proc,
      log: { info: (m) => lines.push(m), error: (m) => lines.push(m) },
    });
    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(44_999);
    expect(f.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.exits).toEqual([1]);
    expect(lines).toEqual([
      '[api] SIGTERM — shutting down',
      '[api] shutdown exceeded 45000ms — exiting anyway',
    ]);
  });

  it('a named deadline code, and a stop that throws still exits', async () => {
    vi.useFakeTimers();
    const f = fakeProcess();
    const hung = onShutdown({
      name: 'server',
      stop: () => new Promise<void>(() => undefined),
      deadlineMs: 5000,
      deadlineExitCode: 0,
      process: f.proc,
      log: quiet,
    });
    void hung('SIGINT');
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.exits).toEqual([0]);
    const g = fakeProcess();
    const errors: unknown[] = [];
    const failing = onShutdown({
      name: 'w',
      stop: async () => {
        throw new Error('boom');
      },
      deadlineMs: 1000,
      process: g.proc,
      log: { info: () => undefined, error: (_m, e) => errors.push(e) },
    });
    await failing('SIGTERM');
    expect(g.exits).toEqual([0]);
    expect((errors[0] as Error).message).toBe('boom');
  });
});
