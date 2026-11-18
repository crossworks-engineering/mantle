/**
 * ICS calendar feeds for the Sync sidecar (Sync service plan M2;
 * docs/calendar-ingest.md): the old feed provider (packages/calendar before
 * M4). Any calendar with an iCal URL: Google (secret address), Outlook
 * (published), iCloud, Fastmail, CalDAV. Read-only.
 *
 * A feed has no cursor: each run pulls the whole document and hands the
 * brain the COMPLETE set (POST /api/sidecar/events), which upserts by UID and
 * removes what left. A recurring event is expanded into its occurrences in a
 * bounded window, each its own event.
 *
 * The fetch is the one egress fetch (docs/egress.md): the URL is one a person
 * pasted, so every hop is checked (a feed or a redirect into private or
 * metadata space is refused) and the body read up to MAX_FEED_BYTES.
 */
import * as ICALns from 'ical.js';
import { EgressTooLargeError, PLATFORM_MAX_REDIRECTS, egressFetch } from '@mantle/std/egress';

export type CalEvent = {
  /** Stable within the feed; an occurrence of a series is `<uid>:<iso>`. */
  uid: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
  location?: string | null;
  description?: string;
  timezone?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ICAL: any = (ICALns as any).default ?? ICALns;

/** Expansion window: recent past through ~13 months out. */
const WINDOW_BACK_MS = 30 * 24 * 60 * 60 * 1000;
const WINDOW_FWD_MS = 400 * 24 * 60 * 60 * 1000;
/** Caps so a pathological feed or RRULE cannot blow up memory. */
const MAX_OCCURRENCES_PER_SERIES = 400;
export const MAX_TOTAL_EVENTS = 5000;
const MAX_FEED_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export async function fetchFeed(url: string): Promise<string> {
  // webcal:// is https for iCal feeds.
  const httpUrl = url.replace(/^webcal:\/\//i, 'https://');
  const res = await egressFetch(
    httpUrl,
    {},
    { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_FEED_BYTES, maxRedirects: PLATFORM_MAX_REDIRECTS },
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`the feed answered ${res.status}`);
  }
  try {
    return await res.text();
  } catch (err) {
    if (err instanceof EgressTooLargeError) throw new Error('the feed is too large', { cause: err });
    throw err;
  }
}

function toIso(t: { toJSDate: () => Date } | null | undefined): string | null {
  try {
    return t ? t.toJSDate().toISOString() : null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tzOf(t: any): string | undefined {
  const tzid = t?.zone?.tzid;
  return typeof tzid === 'string' && tzid && tzid !== 'floating' ? tzid : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapOne(uid: string, start: any, end: any, ev: any): CalEvent | null {
  const startsAt = toIso(start);
  if (!startsAt) return null;
  return {
    uid,
    title: String(ev.summary ?? '(untitled)').slice(0, 200),
    startsAt,
    endsAt: toIso(end),
    allDay: !!start.isDate,
    location: ev.location ? String(ev.location) : null,
    description: ev.description ? String(ev.description) : undefined,
    timezone: tzOf(start),
  };
}

/** The feed's events, cancelled ones left out (the set is complete, so a
 *  cancelled event leaves the brain as one that is gone). */
export function parseFeed(text: string, now = Date.now()): CalEvent[] {
  const comp = new ICAL.Component(ICAL.parse(text));
  const vevents: unknown[] = comp.getAllSubcomponents('vevent') ?? [];
  const windowStart = now - WINDOW_BACK_MS;
  const windowEnd = now + WINDOW_FWD_MS;
  const events: CalEvent[] = [];

  for (const ve of vevents) {
    if (events.length >= MAX_TOTAL_EVENTS) break;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev: any = new ICAL.Event(ve);
    const cancelled =
      String(
        (ve as { getFirstPropertyValue?: (name: string) => unknown }).getFirstPropertyValue?.(
          'status',
        ) ?? '',
      ).toUpperCase() === 'CANCELLED';
    if (cancelled) continue;
    const baseUid = String(ev.uid ?? '').trim();
    if (!baseUid) continue;

    if (ev.isRecurring && ev.isRecurring()) {
      const it = ev.iterator();
      let next = it.next();
      let count = 0;
      while (next && count < MAX_OCCURRENCES_PER_SERIES && events.length < MAX_TOTAL_EVENTS) {
        const startMs = next.toJSDate().getTime();
        if (startMs > windowEnd) break;
        if (startMs >= windowStart) {
          const det = ev.getOccurrenceDetails(next);
          const mapped = mapOne(`${baseUid}:${toIso(det.startDate)}`, det.startDate, det.endDate, ev);
          if (mapped) events.push(mapped);
          count++;
        }
        next = it.next();
      }
    } else {
      const startMs = ev.startDate ? ev.startDate.toJSDate().getTime() : NaN;
      if (Number.isFinite(startMs) && startMs <= windowEnd) {
        const mapped = mapOne(baseUid, ev.startDate, ev.endDate, ev);
        if (mapped) events.push(mapped);
      }
    }
  }
  return events;
}
