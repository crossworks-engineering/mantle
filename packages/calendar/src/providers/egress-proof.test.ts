/**
 * The egress proof table for the calendar feed (A10 part 1, docs/egress.md):
 * an ICS feed URL is one an owner pasted, so its pull is an outbound fetch of
 * a user-given URL. Same seven cells as packages/tools/src/egress-proof.test.ts,
 * on the fake network of @mantle/std/egress-test-net; the provider above it
 * is the real one (the feed URL's unsealing is stubbed).
 *
 * Recorded on the sources before the move (__snapshots__/egress-proof.before.json).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarAccount } from '@mantle/db';

const feed = vi.hoisted(() => ({ url: '' }));
vi.mock('@mantle/crypto', () => ({ open: () => feed.url }));
vi.mock(
  'node:dns/promises',
  async () => (await import('@mantle/std/egress-test-net')).testNetDnsModule,
);

import { cellError, runEgressRow } from '@mantle/std/egress-test-net';
import { icsProvider } from './ics';

const VCAL = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//egress proof//EN', 'END:VCALENDAR'].join(
  '\r\n',
);

const account = {
  id: 'cal-1',
  feedUrlEnc: Buffer.from('x'),
  displayName: 'Work',
} as CalendarAccount;

afterEach(() => vi.unstubAllGlobals());

describe('egress proof table: the calendar feed', () => {
  it('answers each cell as recorded', { timeout: 120_000 }, async () => {
    const row = await runEgressRow(
      VCAL,
      'text/calendar',
      async (base) => {
        feed.url = `${base}/cal.ics`;
        try {
          const pull = await icsProvider.pull(account, undefined);
          return `pulled, ${pull.events.length} events`;
        } catch (err) {
          return cellError(err);
        }
      },
      {
        stubFetch: (f) => vi.stubGlobal('fetch', f),
        timers: {
          useFakeTimers: () => vi.useFakeTimers(),
          useRealTimers: () => vi.useRealTimers(),
          advanceTimersByTimeAsync: (ms) => vi.advanceTimersByTimeAsync(ms),
        },
      },
    );
    await expect(JSON.stringify({ 'calendar ICS feed': row }, null, 1) + '\n').toMatchFileSnapshot(
      './__snapshots__/egress-proof.before.json',
    );
  });
});
