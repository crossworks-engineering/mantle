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
 *  it is not parsed, and the run says so. */
const MAX_BLOCK_CHARS = 64 * 1024 * 1024;
/** A whole run's deadline (the stream of a large feed takes a while). */
const FETCH_TIMEOUT_MS = 10 * 60_000;
/** A UID (an occurrence's carries its start too) and a description, within
 *  the brain's bounds (POST /api/sidecar/events, sidecar-schemas.ts). */
const UID_MAX = 1000;
export const DESCRIPTION_MAX = 20_000;

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
    }
    rest += decoder.decode();
    if (rest) yield rest.replace(/\r$/, '');
  } finally {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapOne(uid: string, start: any, end: any, ev: any): CalEvent | null {
  const startsAt = toIso(start);
  if (!startsAt) return null;
  // Each field within the brain's bounds (POST /api/sidecar/events), so one
  // odd invite can never make the whole feed a 400.
  return {
    uid: uid.slice(0, UID_MAX),
    title: String(ev.summary ?? '(untitled)').slice(0, 200),
    startsAt,
    endsAt: toIso(end),
    allDay: !!start.isDate,
    location: ev.location ? String(ev.location).slice(0, 1000) : null,
    description: ev.description ? String(ev.description).slice(0, DESCRIPTION_MAX) : undefined,
    timezone: tzOf(start),
  };
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
};

export type FeedParser = {
  /** One line of the feed: the events of each VEVENT it completes. */
  line(line: string): CalEvent[];
  end(): FeedEnd;
};

/** A parser fed one line at a time (parsePart reads each VEVENT with the
 *  feed's VTIMEZONEs seen so far, as a parse of the whole document would). */
export function createFeedParser(now = Date.now()): FeedParser {
  const horizon = now + FORWARD_HORIZON_MS;
  const timezones: string[] = [];
  const overrides: CalEvent[] = [];
  const cancelled = new Set<string>();
  const cuts: string[] = [];
  let depth = 0;
  /** The component being collected at the calendar's own level. */
  let block: { kind: string; lines: string[]; chars: number; tooLarge: boolean } | null = null;
  let cutSeries = 0;
  let unreadable = 0;
  let tooLarge = 0;

  function parsePart(kind: string, text: string): CalEvent[] {
    if (kind === 'VTIMEZONE') {
      timezones.push(text);
      return [];
    }
    let comp;
    try {
      comp = new ICAL.Component(
        ICAL.parse(
          ['BEGIN:VCALENDAR', 'VERSION:2.0', ...timezones, text, 'END:VCALENDAR'].join('\r\n'),
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
        const mapped = mapOne(key, ev.startDate, ev.endDate, ev);
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
        const mapped = mapOne(`${baseUid}:${toIso(det.startDate)}`, det.startDate, det.endDate, ev);
        if (mapped) out.push(mapped);
        count++;
        next = it.next();
      }
    } else if (ev.startDate) {
      const mapped = mapOne(baseUid, ev.startDate, ev.endDate, ev);
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
      if (block || depth > 1) cuts.push('the feed ended inside an event');
      if (cutSeries)
        cuts.push(
          `${cutSeries} series cut at ${MAX_OCCURRENCES_PER_SERIES} occurrences before the horizon`,
        );
      if (tooLarge) cuts.push(`${tooLarge} event(s) over 64 MB of text not read`);
      if (unreadable) cuts.push(`${unreadable} event(s) the parser could not read`);
      return { overrides, cancelled, cuts };
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
