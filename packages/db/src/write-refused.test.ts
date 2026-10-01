import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WRITE_RETRY_AFTER_MS,
  bestEffortWrite,
  forgetWriteRefusals,
  isWriteRefused,
} from './write-refused';

/**
 * Read paths that perform an opportunistic write — the traces self-heal, the
 * docs collection seed — used to 500 against a database that will not accept
 * writes. These are the two codes that mean "refused", and just as importantly
 * the ones that must still throw: laundering a broken query into a silent
 * success is a worse bug than the 500 this replaces.
 */
describe('isWriteRefused', () => {
  it('recognises a role without write privilege', () => {
    expect(isWriteRefused({ code: '42501' })).toBe(true);
  });

  it('recognises a read-only transaction', () => {
    expect(isWriteRefused({ code: '25006' })).toBe(true);
  });

  it('unwraps the driver error through a wrapper cause', () => {
    expect(isWriteRefused(new Error('Failed query', { cause: { code: '42501' } }))).toBe(true);
  });

  it('does NOT swallow other database errors', () => {
    expect(isWriteRefused({ code: '23505' })).toBe(false); // unique_violation
    expect(isWriteRefused({ code: '23503' })).toBe(false); // foreign_key_violation
    expect(isWriteRefused({ code: '08006' })).toBe(false); // connection_failure
    expect(isWriteRefused(new Error('boom'))).toBe(false);
    expect(isWriteRefused(null)).toBe(false);
  });
});

/**
 * The guard read paths put around their own writes: a refused write is
 * skipped, any other failure stays loud, and after a refusal the site does
 * not try again for a while, so a read-only brain is not asked on every read.
 */
describe('bestEffortWrite', () => {
  const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
  const refused = () => Promise.reject(pgError('42501'));
  let n = 0;
  /** A site of this test's own: sites keep their state for the process. */
  const site = () => `test site ${++n}`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers what the write answers', async () => {
    expect(await bestEffortWrite(site(), async () => 3)).toBe(3);
  });

  it('answers null for a refused write, whichever way Postgres refuses', async () => {
    for (const code of ['42501', '25006']) {
      expect(await bestEffortWrite(site(), () => Promise.reject(pgError(code)))).toBeNull();
    }
    // Drizzle wraps the driver's error: the code sits on the cause.
    const wrapped = new Error('Failed query', { cause: pgError('42501') });
    expect(await bestEffortWrite(site(), () => Promise.reject(wrapped))).toBeNull();
  });

  it('still throws anything that is not a refusal', async () => {
    const unique = pgError('23505');
    await expect(bestEffortWrite(site(), () => Promise.reject(unique))).rejects.toBe(unique);
    const boom = new Error('boom');
    await expect(bestEffortWrite(site(), () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('does not try another write for a while after a refusal, then tries again', async () => {
    const s = site();
    const write = vi.fn(async () => 'written');
    expect(await bestEffortWrite(s, refused)).toBeNull();
    expect(await bestEffortWrite(s, write)).toBeNull();
    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(WRITE_RETRY_AFTER_MS);
    expect(await bestEffortWrite(s, write)).toBe('written');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('keeps each site to itself: one refused does not pause another', async () => {
    expect(await bestEffortWrite(site(), refused)).toBeNull();
    expect(await bestEffortWrite(site(), async () => 'made')).toBe('made');
  });

  it('warns once per site, and forgetting lets the next write be tried', async () => {
    const s = site();
    const write = vi.fn(refused);
    for (let i = 0; i < 3; i++) {
      forgetWriteRefusals();
      await bestEffortWrite(s, write);
    }
    expect(write).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
