/**
 * The public update-notice view (update-notice.ts): a manual "on" holds
 * while the database cannot be read (the last good read answers), the
 * updater's run counts on its own, and anything that throws past the reads
 * answers off. The sources are stood in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION } from '@mantle/client-types/version';

const readUpdateNotice = vi.fn();
const readUpdaterStatus = vi.fn();
vi.mock('@mantle/content', () => ({ readUpdateNotice: () => readUpdateNotice() }));
vi.mock('@/lib/updates', () => ({ readUpdaterStatus: () => readUpdaterStatus() }));

const { updateNoticeView } = await import('./update-notice');

/** Past the view's 5 s cache, so the next call reads again. */
const next = () => vi.advanceTimersByTime(6_000);

/** Each test starts two hours on: the process cache and memory never carry. */
let clock = Date.parse('2026-11-06T10:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers();
  clock += 2 * 60 * 60 * 1000;
  vi.setSystemTime(clock);
  readUpdateNotice.mockReset();
  readUpdaterStatus.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('updateNoticeView', () => {
  it('a manual on holds while the database cannot be read', async () => {
    readUpdateNotice.mockResolvedValue({ setAt: new Date().toISOString(), version: APP_VERSION });
    expect(await updateNoticeView()).toEqual({ on: true, version: APP_VERSION });
    next();
    readUpdateNotice.mockRejectedValue(new Error('database restarting'));
    expect(await updateNoticeView()).toEqual({ on: true, version: APP_VERSION });
  });

  it('the remembered on still ends with its hour', async () => {
    readUpdateNotice.mockResolvedValue({ setAt: new Date().toISOString(), version: APP_VERSION });
    await updateNoticeView();
    readUpdateNotice.mockRejectedValue(new Error('database restarting'));
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(await updateNoticeView()).toEqual({ on: false, version: APP_VERSION });
  });

  it('an off read clears what was remembered', async () => {
    readUpdateNotice.mockResolvedValue({ setAt: new Date().toISOString(), version: APP_VERSION });
    await updateNoticeView();
    next();
    readUpdateNotice.mockResolvedValue(undefined);
    expect(await updateNoticeView()).toEqual({ on: false, version: APP_VERSION });
  });

  it("the updater's run counts with the database down", async () => {
    readUpdateNotice.mockResolvedValue(undefined);
    await updateNoticeView();
    next();
    readUpdateNotice.mockRejectedValue(new Error('down'));
    readUpdaterStatus.mockResolvedValue({ phase: 'rolling', startedAt: new Date().toISOString() });
    expect(await updateNoticeView()).toEqual({ on: true, version: APP_VERSION });
  });
});
