// The "needs you" phone push (an admin away from the app): when a member
// submits an item for review or files a team request, the admins' paired
// devices get one notice naming the item's title and who it is from, never its
// content. Driven by the "needs you" NOTIFY (migration 0186), which
// also fires when something LEAVES a queue; only an arrival pushes.

import type { NeedsYou, NeedsYouItem } from '@mantle/client-types';

export type NeedsYouArrival = { kind: 'review' | 'request'; item: NeedsYouItem };

/** How recent the newest item must be to count as an arrival. The event
 *  follows the write within a second; the margin covers a slow worker and a
 *  clock skew between the database and this process. */
export const NEEDS_YOU_ARRIVAL_WINDOW_MS = 2 * 60_000;

/** Seen keys kept per process, so the set never grows without bound. */
const SEEN_MAX = 500;

/** One key per wait: a recalled and resubmitted item is a new arrival. */
export const arrivalKey = (a: NeedsYouArrival) => `${a.kind}:${a.item.id}@${a.item.at}`;

/**
 * Pure: what just arrived, newest first. An arrival is a queue's newest item
 * that started waiting within the window and was not pushed before. A queue
 * that only shrank has no new newest item, so a recall, return, accept or a
 * closed request never pushes.
 */
export function needsYouArrivals(
  n: NeedsYou,
  seen: ReadonlySet<string>,
  now: number,
  windowMs = NEEDS_YOU_ARRIVAL_WINDOW_MS,
): NeedsYouArrival[] {
  const out: NeedsYouArrival[] = [];
  if (n.review.newest) out.push({ kind: 'review', item: n.review.newest });
  if (n.requests.newest) out.push({ kind: 'request', item: n.requests.newest });
  return out
    .filter((a) => {
      const at = Date.parse(a.item.at);
      return Number.isFinite(at) && now - at <= windowMs && !seen.has(arrivalKey(a));
    })
    .sort((a, b) => Date.parse(b.item.at) - Date.parse(a.item.at));
}

/** Remember pushed arrivals (oldest forgotten first). */
export function rememberArrivals(seen: Set<string>, arrivals: NeedsYouArrival[]): void {
  for (const a of arrivals) seen.add(arrivalKey(a));
  while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** The lock-screen words: title and author only, and how many wait in all. */
export function needsYouMessage(
  first: NeedsYouArrival,
  total: number,
): { title: string; body: string; deepLink: string } {
  const what = `"${clip(first.item.title || 'Untitled', 80)}" from ${clip(first.item.from, 40)}`;
  const more = total > 1 ? ` (${total} waiting)` : '';
  return first.kind === 'review'
    ? { title: 'Waiting for your review', body: what + more, deepLink: '/team-admin?view=review' }
    : { title: 'New team request', body: what + more, deepLink: '/team-admin?view=requests' };
}
