/**
 * The Sync sidecar's pure parts (Sync service plan M2): the feed parser, the
 * choice of the mailbox that sends, the token check, and that a screen
 * escapes what it shows.
 */
import { describe, expect, it } from 'vitest';
import { parseFeed } from './ics';
import { SendRefusedError, senderFor } from './send';
import { tokenOk } from './server';
import { uiReply, type UiDeps } from './ui';
import type { MailAccount } from './state';

const NOW = Date.parse('2026-11-18T08:00:00Z');

const feed = (body: string) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', body, 'END:VCALENDAR'].join('\r\n');

describe('the feed parser', () => {
  it('reads one event, and leaves out a cancelled one', () => {
    const events = parseFeed(
      feed(
        [
          'BEGIN:VEVENT',
          'UID:a@test',
          'DTSTART:20261120T090000Z',
          'DTEND:20261120T100000Z',
          'SUMMARY:Site visit',
          'LOCATION:Gate 3',
          'END:VEVENT',
          'BEGIN:VEVENT',
          'UID:b@test',
          'DTSTART:20261121T090000Z',
          'SUMMARY:Gone',
          'STATUS:CANCELLED',
          'END:VEVENT',
        ].join('\r\n'),
      ),
      NOW,
    );
    expect(events).toEqual([
      expect.objectContaining({
        uid: 'a@test',
        title: 'Site visit',
        startsAt: '2026-11-20T09:00:00.000Z',
        endsAt: '2026-11-20T10:00:00.000Z',
        location: 'Gate 3',
        allDay: false,
      }),
    ]);
  });

  it('expands a series into occurrences, each its own uid', () => {
    const events = parseFeed(
      feed(
        [
          'BEGIN:VEVENT',
          'UID:weekly@test',
          'DTSTART:20261119T080000Z',
          'RRULE:FREQ=WEEKLY;COUNT=3',
          'SUMMARY:Stand-up',
          'END:VEVENT',
        ].join('\r\n'),
      ),
      NOW,
    );
    expect(events.map((e) => e.uid)).toEqual([
      'weekly@test:2026-11-19T08:00:00.000Z',
      'weekly@test:2026-11-26T08:00:00.000Z',
      'weekly@test:2026-12-03T08:00:00.000Z',
    ]);
  });

  it('marks an all-day event', () => {
    const [ev] = parseFeed(
      feed(
        [
          'BEGIN:VEVENT',
          'UID:d@test',
          'DTSTART;VALUE=DATE:20261125',
          'SUMMARY:Holiday',
          'END:VEVENT',
        ].join('\r\n'),
      ),
      NOW,
    );
    expect(ev?.allDay).toBe(true);
  });
});

const account = (over: Partial<MailAccount>): MailAccount => ({
  id: '00000000-0000-4000-8000-000000000001',
  address: 'a@example.com',
  imap: { host: 'imap.example.com', port: 993, secure: true },
  smtp: { host: 'smtp.example.com', port: 465, secure: true },
  password: 'pw',
  firstScanDays: 365,
  excludedFolders: [],
  includedFolders: null,
  enabled: true,
  ...over,
});

describe('the mailbox that sends', () => {
  const a = account({});
  const b = account({ id: '00000000-0000-4000-8000-000000000002', address: 'b@example.com' });
  const noSmtp = account({
    id: '00000000-0000-4000-8000-000000000003',
    address: 'c@example.com',
    smtp: null,
  });
  const off = account({
    id: '00000000-0000-4000-8000-000000000004',
    address: 'd@example.com',
    enabled: false,
  });

  it('is the one at `from`, in any case', () => {
    expect(senderFor([a, b], 'B@Example.com').address).toBe('b@example.com');
  });

  it('is the first enabled one with SMTP otherwise', () => {
    expect(senderFor([off, noSmtp, b, a]).address).toBe('b@example.com');
  });

  it('refuses a `from` that cannot send, and a box with none that can', () => {
    expect(() => senderFor([a, noSmtp], 'c@example.com')).toThrow(SendRefusedError);
    expect(() => senderFor([a, off], 'd@example.com')).toThrow(SendRefusedError);
    expect(() => senderFor([noSmtp, off])).toThrow(SendRefusedError);
  });
});

describe('the token', () => {
  it('takes only the exact token', () => {
    expect(tokenOk('t0ken', 't0ken')).toBe(true);
    expect(tokenOk('t0ke', 't0ken')).toBe(false);
    expect(tokenOk(undefined, 't0ken')).toBe(false);
    expect(tokenOk(['t0ken'], 't0ken')).toBe(false);
    // A sidecar with no token takes nothing.
    expect(tokenOk('', '')).toBe(false);
  });
});

describe('the screens', () => {
  const evil = account({ address: 'x@example.com', displayName: '<script>alert(1)</script>' });
  const deps = {
    brain: {} as UiDeps['brain'],
    scheduler: { stop() {}, tick: async () => {}, runNow() {} },
    state: {
      accounts: async () => [evil],
      feeds: async () => [
        {
          id: '00000000-0000-4000-8000-0000000000aa',
          name: '"><b>x</b>',
          url: 'https://example.com/a.ics',
          enabled: true,
        },
      ],
      status: async () => null,
      account: async () => evil,
    } as unknown as UiDeps['state'],
  } satisfies UiDeps;
  const req = (path: string) => ({
    method: 'GET',
    path,
    form: new URLSearchParams(),
    base: '/api/services/sync/ui',
    ticket: 'tk"<',
  });

  it('escapes what they show, and puts the ticket in every link', async () => {
    const list = await uiReply(req('/'), deps);
    expect(list.status).toBe(200);
    expect(list.html).not.toContain('<b>x</b>');
    expect(list.html).toContain('&quot;&gt;&lt;b&gt;x&lt;/b&gt;');
    expect(list.html).toContain('t=tk%22%3C');
    expect(list.html).not.toContain('<script');
    const form = await uiReply(req(`/mailbox/${evil.id}`), deps);
    expect(form.html).not.toContain('<script>alert');
    // A feed's URL is never shown again.
    expect(list.html).not.toContain('example.com/a.ics');
  });

  it('answers 404 for a path it does not know, and never shows a password', async () => {
    expect((await uiReply(req('/nope'), deps)).status).toBe(404);
    expect((await uiReply(req('/mailbox/not-a-uuid'), deps)).status).toBe(404);
    const form = await uiReply(req(`/mailbox/${evil.id}`), deps);
    expect(form.html).not.toContain('value="pw"');
  });
});
