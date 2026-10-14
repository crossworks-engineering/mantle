/**
 * The egress proof table for the calendar feed (A10 part 1, docs/egress.md):
 * an ICS feed URL is one an owner pasted, so its pull is an outbound fetch of
 * a user-given URL. Same seven cells as packages/tools/src/egress-proof.test.ts,
 * on the fake network of @mantle/std/egress-test-net; the provider above it
 * is the real one (the feed URL's unsealing is stubbed).
 *
 * Record, move, compare: recorded on the sources before the move
 * (__snapshots__/egress-proof.before.json, never rewritten); after the move
 * it must equal that but for the NAMED changes below
 * (__snapshots__/egress-proof.after.json).
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarAccount } from '@mantle/db';

const feed = vi.hoisted(() => ({ url: '' }));
vi.mock('@mantle/crypto', () => ({ open: () => feed.url }));
vi.mock(
  'node:dns/promises',
  async () => (await import('@mantle/std/egress-test-net')).testNetDnsModule,
);

import {
  cellError,
  runEgressRow,
  withNamedChanges,
  type EgressTable,
  type NamedChanges,
} from '@mantle/std/egress-test-net';
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

const ROW = 'calendar ICS feed';

/** The named changes: a feed (or a redirect) into private or metadata space
 *  is refused, and the body is read up to the 12 MB cap and no further. */
const NAMED: NamedChanges = {
  [ROW]: {
    'private IP': {
      answer: 'error: refusing to fetch a private/internal address (10.0.0.5)',
      reached: [],
    },
    'name resolving to 127.0.0.1': {
      answer:
        'error: refusing to fetch inside.test \u2014 it resolves to a private/internal address',
      reached: [],
    },
    'redirect to 169.254.169.254': {
      answer: 'error: refusing to fetch a private/internal address (169.254.169.254)',
      reached: ['meta-redirect.test'],
    },
    'oversized body': { oversizedRead: 'stopped at 12 MB' },
  },
};

describe('egress proof table: the calendar feed', () => {
  it(
    'answers each cell as before the move, but for the named changes',
    { timeout: 120_000 },
    async () => {
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
      const table: EgressTable = { [ROW]: row };
      const before = JSON.parse(
        readFileSync(new URL('./__snapshots__/egress-proof.before.json', import.meta.url), 'utf8'),
      ) as EgressTable;
      expect(table).toEqual(withNamedChanges(before, NAMED));
      await expect(JSON.stringify(table, null, 1) + '\n').toMatchFileSnapshot(
        './__snapshots__/egress-proof.after.json',
      );
    },
  );
});
