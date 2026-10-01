/**
 * The guard around the writes a tree read makes for itself (refused-write.ts):
 * a refused write is skipped, any other failure stays loud, and after a
 * refusal the next writes are not tried for a while.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('unlessWriteRefused', () => {
  let guard: typeof import('./refused-write');

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    guard = await import('./refused-write');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers what the write answers', async () => {
    expect(await guard.unlessWriteRefused(async () => 3)).toBe(3);
  });

  it('answers null for a refused write, whichever way Postgres refuses', async () => {
    for (const code of ['42501', '25006']) {
      guard.forgetWriteRefusal();
      expect(await guard.unlessWriteRefused(() => Promise.reject(pgError(code)))).toBeNull();
    }
    // Drizzle wraps the driver's error: the code sits on the cause.
    guard.forgetWriteRefusal();
    const wrapped = new Error('Failed query', { cause: pgError('42501') });
    expect(await guard.unlessWriteRefused(() => Promise.reject(wrapped))).toBeNull();
  });

  it('still throws anything that is not a refusal', async () => {
    const unique = pgError('23505');
    await expect(guard.unlessWriteRefused(() => Promise.reject(unique))).rejects.toBe(unique);
    const boom = new Error('boom');
    await expect(guard.unlessWriteRefused(() => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('does not try another write for a while after a refusal, then tries again', async () => {
    const write = vi.fn(async () => 'written');
    expect(await guard.unlessWriteRefused(() => Promise.reject(pgError('42501')))).toBeNull();
    expect(await guard.unlessWriteRefused(write)).toBeNull();
    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(guard.WRITE_RETRY_AFTER_MS);
    expect(await guard.unlessWriteRefused(write)).toBe('written');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('warns once per process', async () => {
    for (let i = 0; i < 3; i++) {
      guard.forgetWriteRefusal();
      await guard.unlessWriteRefused(() => Promise.reject(pgError('42501')));
    }
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
