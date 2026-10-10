// The "needs you" phone push (an admin away from the app): when a member
// submits an item for review or files a team request, the admins' paired
// devices get one notice naming the item's title and who it is from, never its
// content. It opens the item in its own workspace (Pages, Notes, Tables, Draw,
// Files), where admins approve it since Team admin > Review went (2026-10-09). Since 0230 also when embeddings or extraction start failing (no
// credits, a refused key, a long outage): the fixed reason, never provider
// text. Driven by the "needs you" NOTIFY (migration 0186), which
// also fires when something LEAVES a queue; only an arrival pushes.

import type { NeedsYou, NeedsYouItem, ProviderAlert } from '@mantle/client-types';

export type NeedsYouArrival =
  | { kind: 'review' | 'request'; item: NeedsYouItem }
  | { kind: 'provider'; item: NeedsYouItem; alert: ProviderAlert }
  | { kind: 'parked'; item: NeedsYouItem; count: number };

/** Extractions the workspaces heads check parked (server side only, never on
 *  the wire): how many, and when the newest was parked. */
export type ParkedSummary = { count: number; newest: string | null };

/** How recent the newest item must be to count as an arrival. The event
 *  follows the write within a second; the margin covers a slow worker and a
 *  clock skew between the database and this process. */
export const NEEDS_YOU_ARRIVAL_WINDOW_MS = 2 * 60_000;

/** A provider outage is pushed once, while it is new: a permanent one shows
 *  at once, a transient one after 10 min, so its start may be 11 min old when
 *  it first shows. The window also stops a restarted worker (empty `seen`)
 *  from pushing an old outage again. */
export const PROVIDER_ARRIVAL_WINDOW_MS = 30 * 60_000;

/** The push item for an outage: the subject as id, the start as its time. */
function providerItem(a: ProviderAlert): NeedsYouItem {
  return { id: a.subject, title: a.reason, from: a.provider ?? '', at: a.since };
}

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
  parked: ParkedSummary | null = null,
): NeedsYouArrival[] {
  const out: NeedsYouArrival[] = [];
  if (n.review.newest) out.push({ kind: 'review', item: n.review.newest });
  if (n.requests.newest) out.push({ kind: 'request', item: n.requests.newest });
  for (const alert of n.providers ?? []) {
    out.push({ kind: 'provider', item: providerItem(alert), alert });
  }
  if (parked && parked.count > 0 && parked.newest) {
    out.push({
      kind: 'parked',
      item: { id: 'extract-parked', title: 'Extraction parked', from: '', at: parked.newest },
      count: parked.count,
    });
  }
  return out
    .filter((a) => {
      const at = Date.parse(a.item.at);
      const win =
        a.kind === 'review' || a.kind === 'request' ? windowMs : PROVIDER_ARRIVAL_WINDOW_MS;
      return Number.isFinite(at) && now - at <= win && !seen.has(arrivalKey(a));
    })
    .sort((a, b) => Date.parse(b.item.at) - Date.parse(a.item.at));
}

/** Remember pushed arrivals (oldest forgotten first). */
export function rememberArrivals(seen: Set<string>, arrivals: NeedsYouArrival[]): void {
  for (const a of arrivals) seen.add(arrivalKey(a));
  while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
}

/** The workspace screen each review kind is approved in (workspace review
 *  pattern, 2026-10-09): the item opens there, beside its tree. */
const REVIEW_WORKSPACE: Record<NonNullable<NeedsYouItem['type']>, string> = {
  page: '/pages',
  note: '/notes',
  table: '/tables',
  draw: '/draw',
  file: '/files',
};

/** Where a review push opens: the item in its workspace's "Waiting for
 *  approval" section. A kind this code does not know opens Pages. */
export function reviewDeepLink(item: NeedsYouItem): string {
  const base = (item.type && REVIEW_WORKSPACE[item.type]) || '/pages';
  return `${base}?review=${encodeURIComponent(item.id)}`;
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** The lock-screen words: title and author only, and how many wait in all.
 *  An outage: what fails, the fixed reason, and how many jobs wait. */
export function needsYouMessage(
  first: NeedsYouArrival,
  total: number,
): { title: string; body: string; deepLink: string } {
  if (first.kind === 'parked') {
    return {
      title: 'Extraction parked',
      body:
        first.count === 1
          ? 'An item was refused by the access check and waits for a fix.'
          : `${first.count} items were refused by the access check and wait for a fix.`,
      deepLink: '/debug/integrity',
    };
  }
  if (first.kind === 'provider') {
    const a = first.alert;
    const waiting = a.waiting
      ? a.waiting === 1
        ? ' 1 item waits.'
        : ` ${a.waiting} items wait.`
      : '';
    return a.subject === 'embedding'
      ? {
          title: 'Embeddings are failing',
          body: a.reason + waiting,
          deepLink: '/settings/embedding',
        }
      : {
          title: 'Extraction is failing',
          body: a.reason + waiting,
          deepLink: '/settings/ai-workers',
        };
  }
  const what = `"${clip(first.item.title || 'Untitled', 80)}" from ${clip(first.item.from, 40)}`;
  const more = total > 1 ? ` (${total} waiting)` : '';
  return first.kind === 'review'
    ? { title: 'Waiting for your review', body: what + more, deepLink: reviewDeepLink(first.item) }
    : { title: 'New team request', body: what + more, deepLink: '/team-admin?view=requests' };
}
