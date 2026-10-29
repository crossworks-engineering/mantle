// The "needs you" phone push (an admin away from the app): when embeddings or
// extraction start failing (no credits, a refused key, a long outage; since
// 0230) the admins' paired devices get one notice with the fixed reason,
// never provider text; and when the workspaces heads check parks an
// extraction. Driven by the "needs you" NOTIFY (migration 0186), which also
// fires when something clears; only an arrival pushes.

import type { ProviderAlert } from '@mantle/client-types';

/** What a push names: an id for the seen set, a title, who or what it is
 *  from, and when it started. */
export type NeedsYouItem = { id: string; title: string; from: string; at: string };

export type NeedsYouArrival =
  | { kind: 'provider'; item: NeedsYouItem; alert: ProviderAlert }
  | { kind: 'parked'; item: NeedsYouItem; count: number };

/** Extractions the workspaces heads check parked (server side only, never on
 *  the wire): how many, and when the newest was parked. */
export type ParkedSummary = { count: number; newest: string | null };

/** A provider outage is pushed once, while it is new: a permanent one shows
 *  at once, a transient one after 10 min, so its start may be 11 min old when
 *  it first shows. The window also stops a restarted worker (empty `seen`)
 *  from pushing an old outage again. A parked extraction uses it too. */
export const PROVIDER_ARRIVAL_WINDOW_MS = 30 * 60_000;

/** The push item for an outage: the subject as id, the start as its time. */
function providerItem(a: ProviderAlert): NeedsYouItem {
  return { id: a.subject, title: a.reason, from: a.provider ?? '', at: a.since };
}

/** Seen keys kept per process, so the set never grows without bound. */
const SEEN_MAX = 500;

/** One key per wait: an outage that clears and starts again is a new arrival. */
export const arrivalKey = (a: NeedsYouArrival) => `${a.kind}:${a.item.id}@${a.item.at}`;

/**
 * Pure: what just arrived, newest first. An arrival started within the
 * window and was not pushed before, so something that only cleared never
 * pushes.
 */
export function needsYouArrivals(
  providers: readonly ProviderAlert[],
  seen: ReadonlySet<string>,
  now: number,
  parked: ParkedSummary | null = null,
): NeedsYouArrival[] {
  const out: NeedsYouArrival[] = [];
  for (const alert of providers) {
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
      return (
        Number.isFinite(at) && now - at <= PROVIDER_ARRIVAL_WINDOW_MS && !seen.has(arrivalKey(a))
      );
    })
    .sort((a, b) => Date.parse(b.item.at) - Date.parse(a.item.at));
}

/** Remember pushed arrivals (oldest forgotten first). */
export function rememberArrivals(seen: Set<string>, arrivals: NeedsYouArrival[]): void {
  for (const a of arrivals) seen.add(arrivalKey(a));
  while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
}

/** The lock-screen words. An outage: what fails, the fixed reason, and how
 *  many jobs wait. A parked extraction: how many, no title. */
export function needsYouMessage(first: NeedsYouArrival): {
  title: string;
  body: string;
  deepLink: string;
} {
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
  const a = first.alert;
  const waiting = a.waiting
    ? a.waiting === 1
      ? ' 1 item waits.'
      : ` ${a.waiting} items wait.`
    : '';
  return a.subject === 'embedding'
    ? { title: 'Embeddings are failing', body: a.reason + waiting, deepLink: '/settings/embedding' }
    : {
        title: 'Extraction is failing',
        body: a.reason + waiting,
        deepLink: '/settings/ai-workers',
      };
}
