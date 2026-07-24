/**
 * Pure time helpers for the events surface — countdowns, relative labels, the
 * approach-ring + in-progress fractions, day grouping, and an .ics builder.
 * Pure (no React, no DOM) so they're unit-testable and reusable on the server
 * (share presenter) and client (live detail). All take `now` (ms) explicitly so
 * the live components can drive them off a ticking clock and tests are
 * deterministic.
 */

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export type EventState = 'upcoming' | 'in_progress' | 'past';

/** Where an event sits relative to `now`. An event with no end is treated as a
 *  point in time (in_progress only at the exact instant, then past). */
export function eventState(startsAt: string, endsAt: string | null, now: number): EventState {
  const start = new Date(startsAt).getTime();
  const end = endsAt ? new Date(endsAt).getTime() : start;
  if (now < start) return 'upcoming';
  if (now <= end) return 'in_progress';
  return 'past';
}

export type CountdownParts = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  total: number; // remaining ms (clamped ≥ 0)
};

/** Break the time until `targetIso` into d/h/m/s (clamped at zero). */
export function countdownParts(targetIso: string, now: number): CountdownParts {
  const total = Math.max(0, new Date(targetIso).getTime() - now);
  let ms = total;
  const days = Math.floor(ms / DAY);
  ms -= days * DAY;
  const hours = Math.floor(ms / HOUR);
  ms -= hours * HOUR;
  const minutes = Math.floor(ms / MIN);
  ms -= minutes * MIN;
  const seconds = Math.floor(ms / 1000);
  return { days, hours, minutes, seconds, total };
}

/** Compact relative label for list cards: "in 3d", "in 5h", "in 12m", "now",
 *  "5m ago", "2d ago". Minute-resolution (the list ticks per minute). */
export function formatRelativeShort(iso: string, now: number): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  if (abs < MIN) return 'now';
  const unit = abs >= DAY ? 'd' : abs >= HOUR ? 'h' : 'm';
  const n =
    abs >= DAY
      ? Math.round(abs / DAY)
      : abs >= HOUR
        ? Math.round(abs / HOUR)
        : Math.round(abs / MIN);
  return diff > 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
}

/** Fraction (0..1) through an event with a known end — for the in-progress bar. */
export function eventProgress(startsAt: string, endsAt: string | null, now: number): number {
  if (!endsAt) return 0;
  const s = new Date(startsAt).getTime();
  const e = new Date(endsAt).getTime();
  if (e <= s) return 0;
  return Math.min(1, Math.max(0, (now - s) / (e - s)));
}

/** Ring fill (0..1) for an upcoming event: empty until `horizonMs` before start,
 *  then fills smoothly to full at start. Default horizon: 7 days. */
export function approachProgress(startsAt: string, now: number, horizonMs = 7 * DAY): number {
  const remaining = new Date(startsAt).getTime() - now;
  if (remaining <= 0) return 1;
  if (remaining >= horizonMs) return 0;
  return 1 - remaining / horizonMs;
}

export type DayGroup = 'today' | 'tomorrow' | 'this_week' | 'later' | 'past';

/** Bucket an event by its start, in the given IANA timezone, relative to `now`.
 *  Day boundaries are computed in `tz` so "today" matches the user's wall clock. */
export function dayGroup(startsAt: string, now: number, tz: string): DayGroup {
  const start = new Date(startsAt).getTime();
  const startDay = dayIndex(start, tz);
  const nowDay = dayIndex(now, tz);
  const delta = startDay - nowDay;
  if (delta < 0) return 'past';
  if (delta === 0) return 'today';
  if (delta === 1) return 'tomorrow';
  if (delta <= 7) return 'this_week';
  return 'later';
}

/** Integer day number (since epoch) for an instant, in `tz`. */
function dayIndex(ms: number, tz: string): number {
  // en-CA → YYYY-MM-DD; Date.UTC of those parts gives a tz-independent day count.
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(ms))
    .split('-')
    .map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / DAY);
}

/** RFC5545 UTC stamp: 20260524T143000Z. */
function icsStamp(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}
function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export type IcsInput = {
  title: string;
  body?: string;
  startsAt: string | null;
  endsAt?: string | null;
  location?: string | null;
};

/** Build an `.ics` data URL so the event can be added to any calendar. Null if
 *  there's no start. Shared by the events detail + the public share presenter. */
export function buildIcsHref(e: IcsInput): string | null {
  if (!e.startsAt) return null;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mantle//Events//EN',
    'BEGIN:VEVENT',
    `UID:${icsStamp(e.startsAt)}-${Math.random().toString(36).slice(2)}@mantle`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(e.startsAt)}`,
    ...(e.endsAt ? [`DTEND:${icsStamp(e.endsAt)}`] : []),
    `SUMMARY:${icsEscape(e.title)}`,
    ...(e.location ? [`LOCATION:${icsEscape(e.location)}`] : []),
    ...(e.body ? [`DESCRIPTION:${icsEscape(e.body)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join('\r\n'))}`;
}
