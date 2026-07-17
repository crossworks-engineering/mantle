import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarAccount } from '@mantle/db';
import type { CalEvent } from '../types';

/**
 * ICS parsing — the highest-risk parse path in calendar sync. This is what turns
 * an untrusted third-party feed into event nodes, so its edge cases (recurrence
 * expansion, all-day flags, cancellations, missing fields, safety caps,
 * malformed input) directly decide what lands in — or gets wiped from — the
 * brain. We run the REAL ical.js parser and mock only the two seams the provider
 * reaches outside itself: @mantle/crypto.open (feed URL) and global fetch (the
 * feed body). Dates are built relative to Date.now() and emitted in UTC so the
 * suite is deterministic regardless of when/where it runs.
 */

vi.mock('@mantle/crypto', () => ({ open: () => 'https://feed.example/cal.ics' }));

import { icsProvider } from './ics';

const account = {
  id: 'cal-1',
  feedUrlEnc: Buffer.from('x'),
  displayName: 'Work',
} as CalendarAccount;

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

/** Serve this ICS body as the feed for the next pull. */
function feed(body: string) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => body } as Response);
}

const DAY = 24 * 60 * 60 * 1000;
// Zero the milliseconds: ICS timestamps are whole-second precision, so a fixture
// carrying millis would never round-trip through ical.js.
const daysFromNow = (n: number) => new Date(Math.floor((Date.now() + n * DAY) / 1000) * 1000);
/** UTC ical timestamp, e.g. 20260722T120000Z. */
const dt = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
/** Date-only ical value, e.g. 20260722. */
const date = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

function vcal(...vevents: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...vevents, 'END:VCALENDAR'].join(
    '\r\n',
  );
}

/** Assert exactly one event and return it (narrowed to CalEvent). */
function one(events: CalEvent[]): CalEvent {
  expect(events).toHaveLength(1);
  const [e] = events;
  if (!e) throw new Error('expected exactly one event');
  return e;
}

describe('icsProvider.pull — single events', () => {
  it('maps a normal timed event with all fields', async () => {
    const start = daysFromNow(3);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    feed(
      vcal(
        [
          'BEGIN:VEVENT',
          'UID:evt-1',
          'SUMMARY:Team sync',
          `DTSTART:${dt(start)}`,
          `DTEND:${dt(end)}`,
          'LOCATION:Room 4',
          'DESCRIPTION:Weekly catch-up',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    );

    const pull = await icsProvider.pull(account, undefined);
    expect(pull.fullSet).toBe(true);
    const e = one(pull.events);
    expect(e.uid).toBe('evt-1');
    expect(e.title).toBe('Team sync');
    expect(e.startsAt).toBe(start.toISOString());
    expect(e.endsAt).toBe(end.toISOString());
    expect(e.allDay).toBe(false);
    expect(e.location).toBe('Room 4');
    expect(e.description).toBe('Weekly catch-up');
    expect(e.status).toBe('confirmed');
  });

  it('flags an all-day (VALUE=DATE) event', async () => {
    feed(
      vcal(
        [
          'BEGIN:VEVENT',
          'UID:allday-1',
          'SUMMARY:Holiday',
          `DTSTART;VALUE=DATE:${date(daysFromNow(5))}`,
          'END:VEVENT',
        ].join('\r\n'),
      ),
    );
    const pull = await icsProvider.pull(account, undefined);
    expect(one(pull.events).allDay).toBe(true);
  });

  it('falls back to "(untitled)" when SUMMARY is absent', async () => {
    feed(
      vcal(
        ['BEGIN:VEVENT', 'UID:no-title', `DTSTART:${dt(daysFromNow(1))}`, 'END:VEVENT'].join(
          '\r\n',
        ),
      ),
    );
    const pull = await icsProvider.pull(account, undefined);
    expect(one(pull.events).title).toBe('(untitled)');
  });

  it('marks STATUS:CANCELLED events as cancelled (the deletion tombstone)', async () => {
    feed(
      vcal(
        [
          'BEGIN:VEVENT',
          'UID:cancel-1',
          'SUMMARY:Dropped',
          `DTSTART:${dt(daysFromNow(2))}`,
          'STATUS:CANCELLED',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    );
    const pull = await icsProvider.pull(account, undefined);
    expect(one(pull.events).status).toBe('cancelled');
  });

  it('leaves timezone undefined for a floating time (no TZID, no Z)', async () => {
    const d = daysFromNow(4);
    const floating = `${date(d)}T090000`; // no trailing Z
    feed(
      vcal(
        [
          'BEGIN:VEVENT',
          'UID:float-1',
          'SUMMARY:Floating',
          `DTSTART:${floating}`,
          'END:VEVENT',
        ].join('\r\n'),
      ),
    );
    const pull = await icsProvider.pull(account, undefined);
    expect(one(pull.events).timezone).toBeUndefined();
  });

  it('truncates an over-long title to 200 chars', async () => {
    feed(
      vcal(
        [
          'BEGIN:VEVENT',
          'UID:long',
          `SUMMARY:${'A'.repeat(500)}`,
          `DTSTART:${dt(daysFromNow(1))}`,
          'END:VEVENT',
        ].join('\r\n'),
      ),
    );
    const pull = await icsProvider.pull(account, undefined);
    expect(one(pull.events).title).toHaveLength(200);
  });
});

describe('icsProvider.pull — skips and window bounds', () => {
  it('skips a VEVENT with no UID', async () => {
    feed(
      vcal(
        ['BEGIN:VEVENT', 'SUMMARY:No id', `DTSTART:${dt(daysFromNow(1))}`, 'END:VEVENT'].join(
          '\r\n',
        ),
      ),
    );
    const pull = await icsProvider.pull(account, undefined);
    expect(pull.events).toHaveLength(0);
  });

  it('skips a VEVENT with no DTSTART (unmappable)', async () => {
    feed(vcal(['BEGIN:VEVENT', 'UID:no-start', 'SUMMARY:When?', 'END:VEVENT'].join('\r\n')));
    const pull = await icsProvider.pull(account, undefined);
    expect(pull.events).toHaveLength(0);
  });

  it('drops a single event beyond the forward window (~400 days out)', async () => {
    feed(
      vcal(
        [
          'BEGIN:VEVENT',
          'UID:far',
          'SUMMARY:Distant',
          `DTSTART:${dt(daysFromNow(500))}`,
          'END:VEVENT',
        ].join('\r\n'),
      ),
    );
    const pull = await icsProvider.pull(account, undefined);
    expect(pull.events).toHaveLength(0);
  });
});

describe('icsProvider.pull — recurrence', () => {
  it('expands a bounded RRULE into one node per occurrence, each with a distinct uid', async () => {
    const start = daysFromNow(1);
    feed(
      vcal(
        [
          'BEGIN:VEVENT',
          'UID:series-1',
          'SUMMARY:Standup',
          `DTSTART:${dt(start)}`,
          'RRULE:FREQ=DAILY;COUNT=3',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    );
    const pull = await icsProvider.pull(account, undefined);
    expect(pull.events).toHaveLength(3);
    for (const e of pull.events) expect(e.uid.startsWith('series-1:')).toBe(true);
    // Occurrence uids are unique (the per-instance start disambiguates them).
    expect(new Set(pull.events.map((e) => e.uid)).size).toBe(3);
  });

  it('bounds an unbounded RRULE by the occurrence-per-series safety cap (no runaway)', async () => {
    feed(
      vcal(
        [
          'BEGIN:VEVENT',
          'UID:forever',
          'SUMMARY:Daily forever',
          `DTSTART:${dt(daysFromNow(0))}`,
          'RRULE:FREQ=DAILY', // no COUNT/UNTIL
          'END:VEVENT',
        ].join('\r\n'),
      ),
    );
    const pull = await icsProvider.pull(account, undefined);
    // Capped at MAX_OCCURRENCES_PER_SERIES (400) and by the ~400d window.
    expect(pull.events.length).toBeGreaterThan(300);
    expect(pull.events.length).toBeLessThanOrEqual(400);
  });
});

describe('icsProvider.pull — failure containment', () => {
  it('rejects on a malformed feed (the worker must contain this, not persist garbage)', async () => {
    feed('this is not an ical document at all');
    await expect(icsProvider.pull(account, undefined)).rejects.toBeInstanceOf(Error);
  });

  it('rejects when the feed fetch is non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => '' } as Response);
    await expect(icsProvider.pull(account, undefined)).rejects.toThrow(/404/);
  });
});
