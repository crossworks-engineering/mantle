/**
 * A calendar feed's run (Sync service plan M2): pull, parse, hand the brain
 * the complete set (POST /api/sidecar/events), keep the status.
 */
import { errorMessage } from '@mantle/std';
import type { Brain } from './brain';
import { fetchFeed, parseFeed } from './ics';
import type { Feed, State } from './state';

export async function runFeed(brain: Brain, state: State, feed: Feed): Promise<void> {
  try {
    const events = parseFeed(await fetchFeed(feed.url));
    await brain.post('/api/sidecar/events', {
      feedId: feed.id,
      name: feed.name,
      source: 'ics',
      events,
    });
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
