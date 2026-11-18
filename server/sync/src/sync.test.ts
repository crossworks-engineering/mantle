/**
 * The Sync sidecar's pure parts (Sync service plan M2): the feed parser, the
 * choice of the mailbox that sends, the token check, and that a screen
 * escapes what it shows.
 */
import { describe, expect, it } from 'vitest';
import { clipEnvelope, clipMessage, envelopeFits, WIRE_LIMITS } from '@mantle/email/wire';
import { feedBody } from './feeds';
import { parseFeed } from './ics';
import { SendRefusedError, senderFor } from './send';
import { tokenOk } from './server';
import { uiReply, type UiDeps } from './ui';
import { createLane } from './scheduler';
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
    lane: createLane(),
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
      msApp: async () => ({
        clientId: 'client-id-1234',
        clientSecret: 'secret-value-9999',
        tenant: 'common',
        redirectUri: 'https://brain.example/api/microsoft/oauth/callback',
      }),
      msAccounts: async () => [
        {
          id: '00000000-0000-4000-8000-0000000000bb',
          upn: '<i>ms</i>@example.com',
          displayName: null,
          accessToken: 'at-secret',
          refreshToken: 'rt-secret',
          expiresAt: null,
          scopes: [],
          branchPath: 'microsoft.ms_0000',
          mail: false,
          mailboxId: null,
          lastError: '<u>bad</u>',
        },
      ],
      msDrives: async () => [
        {
          id: '00000000-0000-4000-8000-0000000000cc',
          accountId: '00000000-0000-4000-8000-0000000000bb',
          driveId: 'b!1',
          driveType: 'business',
          name: '<em>docs</em>',
          siteName: null,
          webUrl: null,
          branchLabel: 'docs_0000',
          enabled: true,
          selections: [],
        },
      ],
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
    // The Microsoft part: escaped, no token, and the Connect link carries
    // the ticket to the brain's sign-in start.
    expect(list.html).not.toMatch(/<i>|<u>|<em>/);
    expect(list.html).not.toMatch(/at-secret|rt-secret|secret-value/);
    expect(list.html).toContain('/api/services/sync/oauth/start?t=tk%22%3C');
    const app = await uiReply(req('/microsoft/app'), deps);
    expect(app.html).not.toContain('secret-value-9999');
    expect(app.html).toContain('secr…9999');
  });

  it('answers 404 for a path it does not know, and never shows a password', async () => {
    expect((await uiReply(req('/nope'), deps)).status).toBe(404);
    expect((await uiReply(req('/mailbox/not-a-uuid'), deps)).status).toBe(404);
    const form = await uiReply(req(`/mailbox/${evil.id}`), deps);
    expect(form.html).not.toContain('value="pw"');
  });
});

describe('the bounds the brain takes', () => {
  it('never cuts a sender or an id: a message past their bounds is never fetched', () => {
    const long = 'x'.repeat(400);
    // Cut to 320, this sender would end in @acme.com and pass an @acme.com contact.
    const from = `${long}@acme.com.attacker.test`;
    expect(envelopeFits({ providerMsgId: 'INBOX:1:1', fromAddr: from })).toBe(false);
    expect(envelopeFits({ providerMsgId: 'x'.repeat(501), fromAddr: 'a@b.test' })).toBe(false);
    expect(envelopeFits({ providerMsgId: 'INBOX:1:1', fromAddr: 'a@b.test' })).toBe(true);
    const e = clipEnvelope({
      providerMsgId: 'INBOX:1:1',
      fromAddr: from,
      rfcMessageId: 'm'.repeat(2000),
      inReplyTo: 'r'.repeat(2000),
      references: 'x'.repeat(100_000),
    });
    expect(e.fromAddr).toBe(from);
    // An over-long Message-ID is left out, never cut (a cut one could match another).
    expect(e.rfcMessageId).toBeUndefined();
    expect(e.inReplyTo).toBeUndefined();
    expect(e.references!.length).toBe(WIRE_LIMITS.references);
  });

  it('clips the content of a message', () => {
    const long = 'x'.repeat(100_000);
    const m = clipMessage({
      providerMsgId: 'INBOX:1:1',
      fromAddr: 'a@b.test',
      toAddrs: Array.from({ length: 5000 }, (_, i) => `r${i}@a.test`),
      subject: long,
      internalDate: '2026-11-18T00:00:00.000Z',
      attachments: Array.from({ length: 600 }, () => ({ filename: long, contentB64: '' })),
    });
    expect(m.toAddrs).toHaveLength(WIRE_LIMITS.addresses);
    expect(m.subject!.length).toBe(WIRE_LIMITS.subject);
    expect(m.attachments).toHaveLength(WIRE_LIMITS.attachments);
    expect(m.attachments[0]!.filename.length).toBe(WIRE_LIMITS.filename);
  });

  it('keeps a feed post under the byte ceiling: descriptions go first', () => {
    const ev = (i: number) => ({
      uid: `u${i}`,
      title: 't',
      startsAt: '2026-11-20T09:00:00.000Z',
      description: '漢'.repeat(4000),
    });
    const events = Array.from({ length: 5000 }, (_, i) => ev(i));
    type Body = { events: { description?: string }[] };
    const body = JSON.parse(feedBody({ id: 'f', name: 'n' }, events)) as Body;
    expect(body.events).toHaveLength(5000);
    expect(body.events[0]!.description).toBeUndefined();
    const small = JSON.parse(feedBody({ id: 'f', name: 'n' }, events.slice(0, 10))) as Body;
    expect(small.events[0]!.description).toHaveLength(4000);
  });

  it("clips a feed event's long text", () => {
    const [ev] = parseFeed(
      feed(
        [
          'BEGIN:VEVENT',
          `UID:${'u'.repeat(3000)}`,
          'DTSTART:20261120T090000Z',
          'SUMMARY:x',
          `DESCRIPTION:${'d'.repeat(50_000)}`,
          `LOCATION:${'l'.repeat(5000)}`,
          'END:VEVENT',
        ].join('\r\n'),
      ),
      NOW,
    );
    expect(ev!.uid.length).toBeLessThanOrEqual(1000);
    expect(ev!.description!.length).toBe(4000);
    expect(ev!.location!.length).toBe(1000);
  });
});

describe('the job lane', () => {
  it('runs a removal only after the run under way, and answers its result or error', async () => {
    const lane = createLane();
    const seen: string[] = [];
    let release!: () => void;
    void lane.run(
      'feed run',
      () =>
        new Promise<void>(
          (r) =>
            (release = () => {
              seen.push('run done');
              r();
            }),
        ),
    );
    const removal = lane.exclusive(async () => {
      seen.push('removed');
      return 7;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([]);
    release();
    expect(await removal).toBe(7);
    expect(seen).toEqual(['run done', 'removed']);
    await expect(
      lane.exclusive(async () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    // The lane goes on after a failed job.
    expect(await lane.exclusive(async () => 'ok')).toBe('ok');
    expect(lane.depth()).toBe(0);
  });
});
