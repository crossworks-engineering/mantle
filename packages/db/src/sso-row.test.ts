/**
 * The 60-second re-read of company sign-in's setup row (sso-row.ts
 * watchOidcRow): none while the .env has a mode line; a tick every period,
 * never two at once; a tick that throws (a raise into required that cannot
 * work here) calls the process's stop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchOidcRow } from './sso-row';

describe('watchOidcRow', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('a .env mode line: no timer, the row is never read', async () => {
    vi.useFakeTimers();
    vi.stubEnv('MANTLE_OIDC_MODE', 'off');
    const tick = vi.fn(async () => {});
    const stop = watchOidcRow(tick, () => {}, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).not.toHaveBeenCalled();
    stop();
  });

  it('no .env mode line: a tick each period, one at a time; a failed tick stops the process', async () => {
    vi.useFakeTimers();
    vi.stubEnv('MANTLE_OIDC_MODE', '');
    let release: () => void = () => {};
    const tick = vi.fn(() => new Promise<void>((r) => (release = r)));
    const stopped = vi.fn();
    const end = watchOidcRow(tick, stopped, 1000);
    await vi.advanceTimersByTimeAsync(3500);
    // The first tick is still running: no second one started.
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    release();
    tick.mockImplementationOnce(() => Promise.reject(new Error('required but cannot work')));
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'required but cannot work' }),
    );
    end();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});
