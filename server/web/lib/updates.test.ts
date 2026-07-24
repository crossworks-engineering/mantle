import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_VERSION } from '@mantle/web-ui/version';

/**
 * The release-check cache splits its TTL: a confirmed update is cached long
 * (6h — once true it stays true), but a "no update" / error result is cached
 * only briefly (30min) so a release published shortly after this process last
 * checked surfaces in the banner within minutes instead of being suppressed for
 * up to 6h. These tests pin that behaviour against the real `checkForUpdate`.
 */

const bumpMajor = (v: string): string => {
  const p = v
    .split('-')[0]!
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  return `${(p[0] ?? 0) + 1}.0.0`;
};

let nextTag: string;
let fetchCount: number;

function stubFetch() {
  fetchCount = 0;
  vi.stubGlobal('fetch', async () => {
    fetchCount += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        tag_name: nextTag,
        name: nextTag,
        html_url: `https://example.test/${nextTag}`,
        published_at: '2026-06-30T15:17:39Z',
      }),
    } as unknown as Response;
  });
}

describe('checkForUpdate cache TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules(); // fresh module-level cache per test
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('re-checks a "no update" result after the short TTL, surfacing a just-published release', async () => {
    const { checkForUpdate } = await import('./updates');

    // 1) First check while we're on the latest → updateAvailable false, cached.
    nextTag = `v${APP_VERSION}`;
    let r = await checkForUpdate();
    expect(r.updateAvailable).toBe(false);
    expect(fetchCount).toBe(1);

    // 2) 20 min later (< 30min stale TTL) → served from cache, no new fetch.
    vi.advanceTimersByTime(20 * 60 * 1000);
    r = await checkForUpdate();
    expect(r.updateAvailable).toBe(false);
    expect(fetchCount).toBe(1);

    // 3) A new release goes out; 15 more min pass (35 total > 30min) → the stale
    //    negative is re-checked and the update is now seen.
    nextTag = `v${bumpMajor(APP_VERSION)}`;
    vi.advanceTimersByTime(15 * 60 * 1000);
    r = await checkForUpdate();
    expect(r.updateAvailable).toBe(true);
    expect(r.latest?.tag).toBe(nextTag);
    expect(fetchCount).toBe(2);
  });

  it('keeps a positive result cached past the short TTL (long TTL applies)', async () => {
    const { checkForUpdate } = await import('./updates');

    // A confirmed update.
    nextTag = `v${bumpMajor(APP_VERSION)}`;
    let r = await checkForUpdate();
    expect(r.updateAvailable).toBe(true);
    expect(fetchCount).toBe(1);

    // 35 min later (> 30min stale TTL, but << 6h positive TTL) → still cached,
    // no extra GitHub call.
    vi.advanceTimersByTime(35 * 60 * 1000);
    r = await checkForUpdate();
    expect(r.updateAvailable).toBe(true);
    expect(fetchCount).toBe(1);
  });
});
