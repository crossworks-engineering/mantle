/**
 * A calendar feed's run (Sync service plan M2): stream and parse the feed,
 * hand the brain its events in pages (POST /api/sidecar/events, `partial`:
 * upsert only), and only after a run that read every event and posted every
 * page, remove what left the feed (the brain's stored set less this run's).
 * A run that stopped or cut anything removes nothing: an event it did not
 * post is never taken for gone.
 */
import { errorMessage } from '@mantle/std';
import type { Brain } from './brain';
import { createFeedParser, fetchFeedLines } from './ics';
import type { CalEvent } from './ics';
import type { Feed, State } from './state';

/** One page's events at most (the brain's FEED_EVENTS_MAX). */
export const FEED_PAGE_EVENTS = 1000;
/** One page's JSON at most, well under the brain's 32 MB ceiling for
 *  POST /api/sidecar/events: every description goes whole. */
export const FEED_PAGE_BYTES = 8 * 1024 * 1024;
/** Uids one removal post names at most. */
const REMOVE_PAGE = 2000;

type FeedRef = Pick<Feed, 'id' | 'name'>;

/** The page post of `events` (upsert only, no removal). */
export function feedPage(feed: FeedRef, events: CalEvent[], remove?: string[]) {
  return {
    feedId: feed.id,
    name: feed.name,
    source: 'ics' as const,
    partial: true,
    events,
    ...(remove ? { remove } : {}),
  };
}

/** Group events into pages within FEED_PAGE_EVENTS and FEED_PAGE_BYTES. */
export function createPager(post: (events: CalEvent[]) => Promise<void>) {
  let page: CalEvent[] = [];
  let bytes = 0;
  const flush = async () => {
    if (page.length === 0) return;
    const out = page;
    page = [];
    bytes = 0;
    await post(out);
  };
  return {
    async add(ev: CalEvent) {
      const size = Buffer.byteLength(JSON.stringify(ev)) + 1;
      if (page.length >= FEED_PAGE_EVENTS || (page.length > 0 && bytes + size > FEED_PAGE_BYTES))
        await flush();
      page.push(ev);
      bytes += size;
    },
    flush,
  };
}

export type FeedRun = {
  events: number;
  upserted: number;
  failed: number;
  removed: number;
  cuts: string[];
};

/** One run: every event read, posted in pages, then what left removed. */
export async function syncFeed(
  brain: Brain,
  feed: FeedRef,
  lines: AsyncIterable<string>,
  now = Date.now(),
): Promise<FeedRun> {
  const run: FeedRun = { events: 0, upserted: 0, failed: 0, removed: 0, cuts: [] };
  const seen = new Set<string>();
  const pager = createPager(async (events) => {
    const r = await brain.post<{ upserted?: number; failed?: number }>(
      '/api/sidecar/events',
      feedPage(feed, events),
    );
    run.upserted += r?.upserted ?? 0;
    run.failed += r?.failed ?? 0;
  });
  const parser = createFeedParser(now);
  for await (const line of lines) {
    for (const ev of parser.line(line)) {
      seen.add(ev.uid);
      await pager.add(ev);
    }
  }
  const end = parser.end();
  // A changed occurrence after every series: its upsert wins.
  for (const ev of end.overrides) {
    seen.add(ev.uid);
    await pager.add(ev);
  }
  for (const uid of end.cancelled) seen.delete(uid);
  await pager.flush();
  run.events = seen.size;
  run.cuts = end.cuts;
  if (run.cuts.length > 0) return run;

  // Read in full: what the brain holds and this run did not post left.
  const stored = await brain.get<{ uids: string[] }>(
    `/api/sidecar/events?feedId=${encodeURIComponent(feed.id)}`,
  );
  const gone = (stored?.uids ?? []).filter((u) => !seen.has(u));
  for (let i = 0; i < gone.length; i += REMOVE_PAGE) {
    const r = await brain.post<{ removed?: number }>(
      '/api/sidecar/events',
      feedPage(feed, [], gone.slice(i, i + REMOVE_PAGE)),
    );
    run.removed += r?.removed ?? 0;
  }
  return run;
}

/** The status note of a run: what it could not take in, plainly. */
export function feedNote(run: FeedRun): string | undefined {
  const parts = [...run.cuts];
  if (run.failed) parts.push(`${run.failed} event(s) the brain refused`);
  if (run.cuts.length) parts.push('no event was removed this run');
  return parts.length ? parts.join('; ').slice(0, 300) : undefined;
}

export async function runFeed(brain: Brain, state: State, feed: Feed): Promise<void> {
  try {
    const run = await syncFeed(brain, feed, await fetchFeedLines(feed.url));
    const note = feedNote(run);
    await state.putStatus(feed.id, {
      at: new Date().toISOString(),
      ok: true,
      count: run.events,
      ...(note ? { note } : {}),
    });
  } catch (err) {
    // The URL can carry a secret (a private iCal address): never in the text.
    const error = errorMessage(err).split(feed.url).join('(the feed URL)').slice(0, 300);
    console.warn(`[sync] feed ${feed.id} run failed: ${error}`);
    await state.putStatus(feed.id, { at: new Date().toISOString(), ok: false, error });
  }
}

/** A removed feed's events leave the brain (an empty complete set). */
export async function clearFeed(brain: Brain, feed: FeedRef): Promise<void> {
  await brain.post('/api/sidecar/events', {
    feedId: feed.id,
    name: feed.name,
    source: 'ics',
    events: [],
  });
}
