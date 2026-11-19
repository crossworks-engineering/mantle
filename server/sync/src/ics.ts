/**
 * ICS calendar feeds for the Sync sidecar (Sync service plan M2;
 * docs/calendar-ingest.md): the old feed provider (packages/calendar before
 * M4). Any calendar with an iCal URL: Google (secret address), Outlook
 * (published), iCloud, Fastmail, CalDAV. Read-only.
 *
 * A feed has no cursor: each run reads the whole document. It is read as a
 * stream and parsed in parts, one VEVENT at a time (with the feed's
 * VTIMEZONEs), so a feed of any size is taken in with flat memory: no event
 * stop, no description dropped. feeds.ts posts the events to the brain in
 * pages and removes what left only after a run that read every event.
 *
 * The window is pacing only, never a drop: a single event is taken whatever
 * its date, and a series is expanded from its first occurrence through
 * FORWARD_HORIZON_MS from now (an open-ended rule has no last one; each run
 * reaches a little further, so a later occurrence arrives as the horizon
 * passes it). A past occurrence stays in every run's set, so it never leaves
 * the brain for being old.
 *
 * The fetch is the one egress fetch (docs/egress.md): the URL is one a person
 * pasted, so every hop is checked (a feed or a redirect into private or
 * metadata space is refused) and the body read up to MAX_FEED_BYTES.
 */
import { createHash } from 'node:crypto';
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

/** How far ahead a series is expanded (pacing: the horizon moves with each
 *  run). Thirteen months, as before. */
export const FORWARD_HORIZON_MS = 400 * 24 * 60 * 60 * 1000;
/** A series with more occurrences than this up to the horizon (a rule by the
 *  minute or the second) is cut there, and the run says so (its status
 *  names the cut, and no event of the feed is removed). */
export const MAX_OCCURRENCES_PER_SERIES = 50_000;
/** The feed document's own ceiling: a disk/patience number, as the streamed
 *  upload cap (512 MB); the parse holds one event at a time. */
export const MAX_FEED_BYTES = 512 * 1024 * 1024;
/** One VEVENT's text (an inline attachment can make one large): past this
 *  it is not parsed, and the run says so (and removes nothing). */
const MAX_BLOCK_CHARS = 16 * 1024 * 1024;
/** One line's text: past this (a body with no line breaks) the read stops,
 *  and the run removes nothing. */
const MAX_LINE_CHARS = 16 * 1024 * 1024;
/** A whole run's deadline (the stream of a large feed, and the brain's
 *  pages posted as it is read, take a while). */
const FETCH_TIMEOUT_MS = 30 * 60_000;
/** A UID (an occurrence's carries its start too) and a description, within
 *  the brain's bounds (POST /api/sidecar/events, sidecar-schemas.ts). */
const UID_MAX = 1000;
export const DESCRIPTION_MAX = 20_000;
export const TITLE_MAX = 1000;
const LOCATION_MAX = 1000;

/** Open the feed: its body as a stream of text lines. */
export async function fetchFeedLines(url: string): Promise<AsyncIterable<string>> {
  // webcal:// is https for iCal feeds.
  const httpUrl = url.replace(/^webcal:\/\//i, 'https://');
  const res = await egressFetch(
    httpUrl,
    {},
    { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_FEED_BYTES, maxRedirects: PLATFORM_MAX_REDIRECTS },
  );
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`the feed answered ${res.status}`);
  }
  return linesOf(res.body);
}

/** A byte stream as its text lines (CRLF or LF), in order. A body over the
 *  ceiling ends the read with 'the feed is too large'. */
export async function* linesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let rest = '';
  const reader = body.getReader();
  let done = false;
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (err instanceof EgressTooLargeError)
          throw new Error('the feed is too large', { cause: err });
        throw err;
      }
      if (chunk.done) break;
      rest += decoder.decode(chunk.value, { stream: true });
      let at = rest.indexOf('\n');
      while (at >= 0) {
        yield rest.slice(0, at).replace(/\r$/, '');
        rest = rest.slice(at + 1);
        at = rest.indexOf('\n');
      }
      if (rest.length > MAX_LINE_CHARS) throw new Error('a line of the feed is over 16 MB');
    }
    done = true;
    rest += decoder.decode();
    if (rest) yield rest.replace(/\r$/, '');
  } finally {
    // A read that stopped early (an error, a consumer that threw) lets go
    // of the socket at once.
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
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
  // A zone name past the brain's bound (64) is left out: display only.
  return typeof tzid === 'string' && tzid && tzid !== 'floating' && tzid.length <= 64
    ? tzid
    : undefined;
}

/** Text past the brain's bound for its field is cut, and counted. */
function within(v: string, max: number, cut: { texts: number }): string {
  if (v.length <= max) return v;
  cut.texts += 1;
  return v.slice(0, max);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- ical.js has no types */
function mapOne(
  uid: string,
  start: any,
  end: any,
  ev: any,
  cut: { texts: number },
): CalEvent | null {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const startsAt = toIso(start);
  if (!startsAt) return null;
  // Each field within the brain's bounds (POST /api/sidecar/events), so one
  // odd invite can never make the whole feed a 400; a cut is counted for the
  // status (feedNote).
  return {
    uid: uid.slice(0, UID_MAX),
    title: within(String(ev.summary ?? '(untitled)'), TITLE_MAX, cut),
    startsAt,
    endsAt: toIso(end),
    allDay: !!start.isDate,
    location: ev.location ? within(String(ev.location), LOCATION_MAX, cut) : null,
    description: ev.description ? within(String(ev.description), DESCRIPTION_MAX, cut) : undefined,
    timezone: tzOf(start),
  };
}

/** An occurrence key as it is kept between runs (feeds.ts HOLD_KEYS_MAX):
 *  40 bits of its sha1. Two keys that share one only hold a plain
 *  occurrence to the end of the run, where it is posted all the same. */
export function holdKey(uid: string): string {
  return createHash('sha1').update(uid).digest('hex').slice(0, 10);
}

/** What a parse found besides the events it handed out as it went. */
export type FeedEnd = {
  /** Changed occurrences of a series (a RECURRENCE-ID): posted after every
   *  series, so the change wins over the plain occurrence. */
  overrides: CalEvent[];
  /** Occurrences cancelled one by one: not in the feed's set. */
  cancelled: Set<string>;
  /** What could not be taken in, for the status; non-empty: nothing is
   *  removed this run. */
  cuts: string[];
  /** Plain occurrences held back (a key changed or cancelled last run)
   *  that this run has no change for: posted as they are. */
  held: CalEvent[];
  /** What was taken in with a field cut to the brain's bound (a
   *  description past 20 000 characters): for the status, and no reason to
   *  hold removal (the event itself is in the set). */
  notes: string[];
};

export type FeedParser = {
  /** One line of the feed: the events of each VEVENT it completes. */
  line(line: string): CalEvent[];
  end(): FeedEnd;
};

/** A parser fed one line at a time (parsePart reads each VEVENT with the
 *  feed's VTIMEZONEs seen so far, as a parse of the whole document would). */
export function createFeedParser(
  now = Date.now(),
  /** Occurrence keys changed or cancelled in the last run (as holdKey):
   *  their plain occurrence is held to the end, so a change is not written
   *  over the plain one (and back) on every run. */
  hold: ReadonlySet<string> = new Set(),
): FeedParser {
  const held = new Map<string, CalEvent>();
  const horizon = now + FORWARD_HORIZON_MS;
  /** The feed's VTIMEZONEs by TZID: one repeated per event is kept once. */
  const timezones = new Map<string, string>();
  const overrides: CalEvent[] = [];
  const cancelled = new Set<string>();
  const cuts: string[] = [];
  let depth = 0;
  /** VCALENDARs begun and ended: a body that is no iCalendar (a login
   *  page, an empty answer) or one cut between two events is a cut. */
  let calendars = 0;
  let calendarsClosed = 0;
  /** The component being collected at the calendar's own level. */
  let block: { kind: string; lines: string[]; chars: number; tooLarge: boolean } | null = null;
  let cutSeries = 0;
  let unreadable = 0;
  let tooLarge = 0;
  const cut = { texts: 0 };

  function parsePart(kind: string, text: string): CalEvent[] {
    if (kind === 'VTIMEZONE') {
      const tzid = /^TZID[;:](.*)$/im.exec(text)?.[1]?.trim() ?? text;
      timezones.set(tzid, text);
      return [];
    }
    let comp;
    try {
      comp = new ICAL.Component(
        ICAL.parse(
          ['BEGIN:VCALENDAR', 'VERSION:2.0', ...timezones.values(), text, 'END:VCALENDAR'].join(
            '\r\n',
          ),
        ),
      );
    } catch {
      unreadable += 1;
      return [];
    }
    const out: CalEvent[] = [];
    for (const ve of comp.getAllSubcomponents('vevent') ?? []) {
      try {
        out.push(...readEvent(ve));
      } catch {
        unreadable += 1;
      }
    }
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function readEvent(ve: any): CalEvent[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev: any = new ICAL.Event(ve);
    const status = String(ve.getFirstPropertyValue?.('status') ?? '').toUpperCase();
    const baseUid = String(ev.uid ?? '').trim();
    if (!baseUid) return [];
    const recurrenceId = ve.getFirstPropertyValue?.('recurrence-id');
    if (recurrenceId) {
      // One occurrence of a series, changed or cancelled.
      const key = `${baseUid}:${toIso(recurrenceId)}`.slice(0, UID_MAX);
      if (status === 'CANCELLED') cancelled.add(key);
      else {
        const mapped = mapOne(key, ev.startDate, ev.endDate, ev, cut);
        if (mapped) overrides.push(mapped);
      }
      return [];
    }
    // A cancelled event (or series) is not in the set: it leaves the brain
    // as one that is gone.
    if (status === 'CANCELLED') return [];
    const out: CalEvent[] = [];
    if (ev.isRecurring && ev.isRecurring()) {
      const it = ev.iterator();
      let next = it.next();
      let count = 0;
      while (next) {
        if (next.toJSDate().getTime() > horizon) break;
        if (count >= MAX_OCCURRENCES_PER_SERIES) {
          cutSeries += 1;
          break;
        }
        const det = ev.getOccurrenceDetails(next);
        const mapped = mapOne(
          `${baseUid}:${toIso(det.startDate)}`,
          det.startDate,
          det.endDate,
          ev,
          cut,
        );
        if (mapped) {
          if (hold.size > 0 && hold.has(holdKey(mapped.uid))) held.set(mapped.uid, mapped);
          else out.push(mapped);
        }
        count++;
        next = it.next();
      }
    } else if (ev.startDate) {
      const mapped = mapOne(baseUid, ev.startDate, ev.endDate, ev, cut);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  return {
    line(raw: string): CalEvent[] {
      const begin = /^BEGIN:([A-Za-z-]+)\s*$/.exec(raw);
      const end = begin ? null : /^END:([A-Za-z-]+)\s*$/.exec(raw);
      if (begin) {
        depth += 1;
        const kind = begin[1]!.toUpperCase();
        if (depth === 1 && kind === 'VCALENDAR') calendars += 1;
        if (depth === 2 && (kind === 'VEVENT' || kind === 'VTIMEZONE')) {
          block = { kind, lines: [], chars: 0, tooLarge: false };
        }
      }
      if (block) {
        if (!block.tooLarge) {
          block.chars += raw.length + 2;
          if (block.chars > MAX_BLOCK_CHARS) {
            block.tooLarge = true;
            block.lines = [];
          } else block.lines.push(raw);
        }
      }
      if (end) {
        depth = Math.max(0, depth - 1);
        if (depth === 0 && end[1]!.toUpperCase() === 'VCALENDAR') calendarsClosed += 1;
        if (depth === 1 && block) {
          const done: { kind: string; lines: string[]; tooLarge: boolean } = block;
          block = null;
          if (done.tooLarge) {
            tooLarge += 1;
            return [];
          }
          return parsePart(done.kind, done.lines.join('\r\n'));
        }
      }
      return [];
    },
    end(): FeedEnd {
      if (calendars === 0) cuts.push('the feed is not an iCalendar document');
      else if (block || depth > 1) cuts.push('the feed ended inside an event');
      else if (depth > 0 || calendarsClosed < calendars) cuts.push('the feed ended before its end');
      if (cutSeries)
        cuts.push(
          `${cutSeries} series cut at ${MAX_OCCURRENCES_PER_SERIES} occurrences before the horizon`,
        );
      if (tooLarge) cuts.push(`${tooLarge} event(s) over 16 MB of text not read`);
      if (unreadable) cuts.push(`${unreadable} event(s) the parser could not read`);
      const changed = new Set(overrides.map((o) => o.uid));
      const plain = [...held.values()].filter((e) => !changed.has(e.uid) && !cancelled.has(e.uid));
      const notes =
        cut.texts > 0
          ? [
              `${cut.texts} event text(s) cut to the brain's bound (a description past ${DESCRIPTION_MAX} characters)`,
            ]
          : [];
      return { overrides, cancelled, cuts, held: plain, notes };
    },
  };
}

/** The feed's events from a whole document (the tests; a run streams):
 *  overrides in place of the plain occurrences they change, cancelled
 *  occurrences left out. */
export function parseFeed(text: string, now = Date.now()): CalEvent[] {
  const p = createFeedParser(now);
  const events: CalEvent[] = [];
  for (const line of text.split(/\r?\n/)) events.push(...p.line(line));
  const end = p.end();
  const byUid = new Map(events.map((e) => [e.uid, e]));
  for (const o of end.overrides) byUid.set(o.uid, o);
  for (const c of end.cancelled) byUid.delete(c);
  return [...byUid.values()];
}
