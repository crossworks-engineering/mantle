/**
 * A feed run's removal and its writes (sync-complete audit round 1): a body
 * that is no iCalendar, or one cut between two events, removes nothing; a
 * brain from before pages is never posted to; a changed occurrence is not
 * written over its plain one on every run; a cancelled occurrence leaves at
 * once; a line with no end stops the read.
 */
import { describe, expect, it } from 'vitest';
import { syncFeed, feedNote } from './feeds';
import { BrainError, type Brain } from './brain';
import { holdKey, linesOf } from './ics';

const NOW = Date.parse('2026-11-18T08:00:00Z');

const feed = (body: string) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', body, 'END:VCALENDAR'].join('\r\n');

const event = (uid: string, extra: string[] = []) =>
  [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTART:20261120T090000Z',
    'SUMMARY:x',
    ...extra,
    'END:VEVENT',
  ].join('\r\n');

type Post = { events: { uid: string; title: string }[]; remove?: string[]; partial?: boolean };

function feedBrain(stored: string[] | 'old') {
  const posts: Post[] = [];
  const brain = {
    get: async () => {
      if (stored === 'old') throw new BrainError(405, 'the brain answered 405');
      return { uids: stored } as never;
    },
    post: async (_path: string, body: unknown) => {
      posts.push(body as Post);
      const b = body as { events: unknown[]; remove?: unknown[] };
      return { upserted: b.events.length, failed: 0, removed: b.remove?.length ?? 0 } as never;
    },
  } as unknown as Brain;
  return { brain, posts };
}

async function* linesFrom(text: string) {
  for (const l of text.split(/\r?\n/)) yield l;
}

const removed = (posts: Post[]) => posts.flatMap((p) => p.remove ?? []);
const upserted = (posts: Post[]) => posts.flatMap((p) => p.events.map((e) => e.uid));

describe('a feed run that did not read a whole calendar', () => {
  it('removes nothing for an HTML login page', async () => {
    const { brain, posts } = feedBrain(['a@test', 'b@test']);
    const html = '<!doctype html>\n<html><body>Sign in</body></html>';
    const run = await syncFeed(brain, { id: 'f', name: 'n' }, linesFrom(html), NOW);
    expect(run.cuts).toContain('the feed is not an iCalendar document');
    expect(removed(posts)).toEqual([]);
  });

  it('removes nothing for an empty body', async () => {
    const { brain, posts } = feedBrain(['a@test']);
    const run = await syncFeed(brain, { id: 'f', name: 'n' }, linesFrom(''), NOW);
    expect(run.cuts.length).toBeGreaterThan(0);
    expect(removed(posts)).toEqual([]);
  });

  it('removes nothing when the body ends cleanly between two events', async () => {
    const { brain, posts } = feedBrain(['a@test', 'later@test']);
    const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', event('a@test')].join('\r\n');
    const run = await syncFeed(brain, { id: 'f', name: 'n' }, linesFrom(text), NOW);
    expect(run.cuts).toContain('the feed ended before its end');
    expect(upserted(posts)).toEqual(['a@test']);
    expect(removed(posts)).toEqual([]);
    expect(feedNote(run)).toContain('no event was removed');
  });

  it('removes what left after a whole calendar', async () => {
    const { brain, posts } = feedBrain(['a@test', 'gone@test']);
    const run = await syncFeed(
      brain,
      { id: 'f', name: 'n' },
      linesFrom(feed(event('a@test'))),
      NOW,
    );
    expect(run.cuts).toEqual([]);
    expect(removed(posts)).toEqual(['gone@test']);
  });
});

describe('a brain from before pages', () => {
  it('is never posted to: the run fails before the first page', async () => {
    const { brain, posts } = feedBrain('old');
    await expect(
      syncFeed(brain, { id: 'f', name: 'n' }, linesFrom(feed(event('a@test'))), NOW),
    ).rejects.toThrow(/405/);
    expect(posts).toEqual([]);
  });
});

describe('changed and cancelled occurrences', () => {
  const series = feed(
    [
      'BEGIN:VEVENT',
      'UID:s@test',
      'DTSTART:20261119T080000Z',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Daily',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:s@test',
      'RECURRENCE-ID:20261120T080000Z',
      'DTSTART:20261120T100000Z',
      'SUMMARY:Daily, moved',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:s@test',
      'RECURRENCE-ID:20261121T080000Z',
      'DTSTART:20261121T080000Z',
      'STATUS:CANCELLED',
      'SUMMARY:Daily',
      'END:VEVENT',
    ].join('\r\n'),
  );
  const moved = 's@test:2026-11-20T08:00:00.000Z';
  const cancelled = 's@test:2026-11-21T08:00:00.000Z';

  it('removes a cancelled occurrence posted in the same run, and keeps the keys', async () => {
    const { brain, posts } = feedBrain([]);
    const run = await syncFeed(brain, { id: 'f', name: 'n' }, linesFrom(series), NOW);
    expect(removed(posts)).toEqual([cancelled]);
    expect(run.changedKeys.sort()).toEqual([holdKey(moved), holdKey(cancelled)].sort());
    expect(run.events).toBe(2);
  });

  it('writes each changed occurrence once a run, from the second run on', async () => {
    const first = feedBrain([]);
    const r1 = await syncFeed(first.brain, { id: 'f', name: 'n' }, linesFrom(series), NOW);
    const stored = ['s@test:2026-11-19T08:00:00.000Z', moved];
    const second = feedBrain(stored);
    await syncFeed(
      second.brain,
      { id: 'f', name: 'n' },
      linesFrom(series),
      NOW,
      new Set(r1.changedKeys),
    );
    const writes = second.posts.flatMap((p) => p.events);
    expect(writes.filter((e) => e.uid === moved)).toEqual([
      expect.objectContaining({ title: 'Daily, moved' }),
    ]);
    expect(writes.some((e) => e.uid === cancelled)).toBe(false);
    expect(removed(second.posts)).toEqual([]);
  });

  it('posts a held occurrence plain once its change is gone from the feed', async () => {
    const plain = feed(
      [
        'BEGIN:VEVENT',
        'UID:s@test',
        'DTSTART:20261119T080000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        'SUMMARY:Daily',
        'END:VEVENT',
      ].join('\r\n'),
    );
    const { brain, posts } = feedBrain([moved]);
    const run = await syncFeed(
      brain,
      { id: 'f', name: 'n' },
      linesFrom(plain),
      NOW,
      new Set([holdKey(moved), holdKey(cancelled)]),
    );
    expect(upserted(posts).sort()).toEqual(
      ['s@test:2026-11-19T08:00:00.000Z', moved, cancelled].sort(),
    );
    expect(run.changedKeys).toEqual([]);
  });

  it('keeps the first of a uid the feed repeats', async () => {
    const { brain, posts } = feedBrain([]);
    const twice = feed([event('d@test', ['SUMMARY:one']), event('d@test')].join('\r\n'));
    await syncFeed(brain, { id: 'f', name: 'n' }, linesFrom(twice), NOW);
    expect(upserted(posts)).toEqual(['d@test']);
  });
});

describe('text cut to the brain bounds', () => {
  it('is noted in the status and holds no removal', async () => {
    const { brain, posts } = feedBrain(['gone@test']);
    const text = feed(event('a@test', [`DESCRIPTION:${'d'.repeat(25_000)}`]));
    const run = await syncFeed(brain, { id: 'f', name: 'n' }, linesFrom(text), NOW);
    expect(run.cuts).toEqual([]);
    expect(feedNote(run)).toContain('cut to the brain');
    expect(removed(posts)).toEqual(['gone@test']);
  });

  it('keeps a title up to 1000 characters', async () => {
    const { brain, posts } = feedBrain([]);
    const text = feed(
      [
        'BEGIN:VEVENT',
        'UID:t@test',
        'DTSTART:20261120T090000Z',
        `SUMMARY:${'t'.repeat(900)}`,
        'END:VEVENT',
      ].join('\r\n'),
    );
    await syncFeed(brain, { id: 'f', name: 'n' }, linesFrom(text), NOW);
    expect(posts[0]!.events[0]!.title.length).toBe(900);
  });
});

describe('the line reader', () => {
  it('stops at a line past 16 MB and lets go of the body', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(4 * 1024 * 1024).fill(0x61);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        sent += 1;
        if (sent > 10) ctrl.close();
        else ctrl.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const read = async () => {
      for await (const _ of linesOf(body)) void _;
    };
    await expect(read()).rejects.toThrow(/over 16 MB/);
    expect(cancelled).toBe(true);
  });

  it('cancels the body when the reader stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('a\nb\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const line of linesOf(body)) if (line === 'b') break;
    expect(cancelled).toBe(true);
  });
});
