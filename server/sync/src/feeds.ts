/**
 * A calendar feed's run (Sync service plan M2): pull, parse, hand the brain
 * the complete set (POST /api/sidecar/events), keep the status.
 */
import { errorMessage } from '@mantle/std';
import type { Brain } from './brain';
import { fetchFeed, parseFeed } from './ics';
import type { CalEvent } from './ics';
import type { Feed, State } from './state';

/** The largest feed post, in bytes: under the brain's 32 MB ceiling for
 *  POST /api/sidecar/events (the field caps count characters, not bytes). */
const FEED_POST_MAX_BYTES = 30 * 1024 * 1024;

/** The feed's body for the brain, within its byte ceiling: past it, the
 *  descriptions are left out; still past it, the feed is refused here. */
export function feedBody(feed: Pick<Feed, 'id' | 'name'>, events: CalEvent[]): string {
  const body = (evs: CalEvent[]) =>
    JSON.stringify({ feedId: feed.id, name: feed.name, source: 'ics', events: evs });
  const full = body(events);
  if (Buffer.byteLength(full) <= FEED_POST_MAX_BYTES) return full;
  const lean = body(events.map(({ description: _d, ...e }) => e));
  if (Buffer.byteLength(lean) <= FEED_POST_MAX_BYTES) return lean;
  throw new Error('the feed is too large for the brain (over 30 MB without descriptions)');
}

export async function runFeed(brain: Brain, state: State, feed: Feed): Promise<void> {
  try {
    const events = parseFeed(await fetchFeed(feed.url));
    await brain.post('/api/sidecar/events', JSON.parse(feedBody(feed, events)));
    await state.putStatus(feed.id, {
      at: new Date().toISOString(),
      ok: true,
      count: events.length,
    });
  } catch (err) {
    // The URL can carry a secret (a private iCal address): never in the text.
    const error = errorMessage(err).split(feed.url).join('(the feed URL)').slice(0, 300);
    console.warn(`[sync] feed ${feed.id} run failed: ${error}`);
    await state.putStatus(feed.id, { at: new Date().toISOString(), ok: false, error });
  }
}

/** A removed feed's events leave the brain (an empty complete set). */
export async function clearFeed(brain: Brain, feed: Pick<Feed, 'id' | 'name'>): Promise<void> {
  await brain.post('/api/sidecar/events', {
    feedId: feed.id,
    name: feed.name,
    source: 'ics',
    events: [],
  });
}
