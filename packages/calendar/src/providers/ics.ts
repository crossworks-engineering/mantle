/**
 * ICS / iCalendar feed provider — the universal calendar source. Works for any
 * calendar that exposes an iCal URL: Google (secret iCal address), Outlook
 * (published calendar), Apple iCloud, Fastmail, generic CalDAV. Read-only.
 *
 * The feed has no incremental cursor, so we re-pull the whole document each
 * sync and return the COMPLETE set (`fullSet: true`); the orchestrator dedups by
 * uid and reconciles deletions. Recurring events are expanded into individual
 * occurrences within a bounded window so each instance is its own event node
 * (avoids fighting Mantle's single-row roll-forward, and matches what the user
 * sees in their calendar).
 *
 * `ical.js` ships loose types; we keep it behind a localized `any` boundary and
 * stay strongly typed via `CalEvent`.
 */
import * as ICALns from 'ical.js';
import { open } from '@mantle/crypto';
import type { CalendarAccount } from '@mantle/db';
import type { CalEvent, CalendarProvider, CalendarPull } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ICAL: any = (ICALns as any).default ?? ICALns;

/** Expansion window: recent past through ~13 months out. */
const WINDOW_BACK_MS = 30 * 24 * 60 * 60 * 1000;
const WINDOW_FWD_MS = 400 * 24 * 60 * 60 * 1000;
/** Safety caps so a pathological feed/RRULE can't blow up memory. */
const MAX_OCCURRENCES_PER_SERIES = 400;
const MAX_TOTAL_EVENTS = 5000;
const MAX_FEED_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

function feedUrl(account: CalendarAccount): string {
  if (!account.feedUrlEnc) throw new Error(`calendar account ${account.id} has no feed URL`);
  return open(account.feedUrlEnc, account.id);
}

async function fetchFeed(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // webcal:// is just https for iCal feeds.
    const httpUrl = url.replace(/^webcal:\/\//i, 'https://');
    const res = await fetch(httpUrl, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`feed fetch ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_FEED_BYTES) throw new Error('feed too large');
    return text;
  } finally {
    clearTimeout(timer);
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
function mapOne(uid: string, start: any, end: any, ev: any, cancelled: boolean): CalEvent | null {
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
    status: cancelled ? 'cancelled' : 'confirmed',
  };
}

export const icsProvider: CalendarProvider = {
  async pull(account: CalendarAccount): Promise<CalendarPull> {
    const text = await fetchFeed(feedUrl(account));
    const comp = new ICAL.Component(ICAL.parse(text));
    const vevents: unknown[] = comp.getAllSubcomponents('vevent') ?? [];

    const now = Date.now();
    const windowStart = now - WINDOW_BACK_MS;
    const windowEnd = now + WINDOW_FWD_MS;
    const events: CalEvent[] = [];

    for (const ve of vevents) {
      if (events.length >= MAX_TOTAL_EVENTS) break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev: any = new ICAL.Event(ve);
      const cancelled = String((ve as any).getFirstPropertyValue?.('status') ?? '').toUpperCase() === 'CANCELLED';
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
            const mapped = mapOne(`${baseUid}:${toIso(det.startDate)}`, det.startDate, det.endDate, ev, cancelled);
            if (mapped) events.push(mapped);
            count++;
          }
          next = it.next();
        }
      } else {
        const startMs = ev.startDate ? ev.startDate.toJSDate().getTime() : NaN;
        if (Number.isFinite(startMs) && startMs <= windowEnd) {
          const mapped = mapOne(baseUid, ev.startDate, ev.endDate, ev, cancelled);
          if (mapped) events.push(mapped);
        }
      }
    }

    return { events, fullSet: true };
  },
};
