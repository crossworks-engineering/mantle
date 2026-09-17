import { describe, expect, it } from 'vitest';
import {
  approachProgress,
  buildIcsHref,
  countdownParts,
  dayGroup,
  eventProgress,
  eventState,
  formatRelativeShort,
} from './event-time';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = Date.UTC(2026, 4, 25, 12, 0, 0); // 2026-05-25 12:00 UTC
const iso = (ms: number) => new Date(ms).toISOString();

describe('eventState', () => {
  it('classifies upcoming / in_progress / past', () => {
    expect(eventState(iso(NOW + HOUR), null, NOW)).toBe('upcoming');
    expect(eventState(iso(NOW - HOUR), iso(NOW + HOUR), NOW)).toBe('in_progress');
    expect(eventState(iso(NOW - 2 * HOUR), iso(NOW - HOUR), NOW)).toBe('past');
  });
  it('treats a no-end event as a point in time', () => {
    expect(eventState(iso(NOW), null, NOW)).toBe('in_progress'); // exact instant
    expect(eventState(iso(NOW - 1), null, NOW)).toBe('past');
  });
});

describe('countdownParts', () => {
  it('splits remaining time into d/h/m/s', () => {
    const p = countdownParts(iso(NOW + DAY + 2 * HOUR + 3 * MIN + 4000), NOW);
    expect(p).toMatchObject({ days: 1, hours: 2, minutes: 3, seconds: 4 });
  });
  it('clamps the past to zero', () => {
    expect(countdownParts(iso(NOW - HOUR), NOW)).toMatchObject({ days: 0, hours: 0, total: 0 });
  });
});

describe('formatRelativeShort', () => {
  it('formats future + past at the right unit', () => {
    expect(formatRelativeShort(iso(NOW + 3 * DAY), NOW)).toBe('in 3d');
    expect(formatRelativeShort(iso(NOW + 5 * HOUR), NOW)).toBe('in 5h');
    expect(formatRelativeShort(iso(NOW - 5 * HOUR), NOW)).toBe('5h ago');
    expect(formatRelativeShort(iso(NOW + 30_000), NOW)).toBe('now');
  });
});

describe('eventProgress', () => {
  it('is the fraction through a timed event', () => {
    expect(eventProgress(iso(NOW - HOUR), iso(NOW + HOUR), NOW)).toBeCloseTo(0.5);
    expect(eventProgress(iso(NOW), null, NOW)).toBe(0); // no end
  });
});

describe('approachProgress', () => {
  it('fills from 0 (≥horizon away) to 1 (at start)', () => {
    expect(approachProgress(iso(NOW + 7 * DAY), NOW)).toBe(0);
    expect(approachProgress(iso(NOW + 3.5 * DAY), NOW)).toBeCloseTo(0.5);
    expect(approachProgress(iso(NOW), NOW)).toBe(1);
  });
});

describe('dayGroup (UTC)', () => {
  const g = (ms: number) => dayGroup(iso(ms), NOW, 'UTC');
  it('buckets by day boundary', () => {
    expect(g(NOW + 6 * HOUR)).toBe('today');
    expect(g(NOW + DAY)).toBe('tomorrow');
    expect(g(NOW + 3 * DAY)).toBe('this_week');
    expect(g(NOW + 10 * DAY)).toBe('later');
    expect(g(NOW - DAY)).toBe('past');
  });
});

describe('buildIcsHref', () => {
  it('builds a calendar data URL, or null without a start', () => {
    const href = buildIcsHref({ title: 'Standup', startsAt: iso(NOW), location: 'Zoom' });
    expect(href).toMatch(/^data:text\/calendar/);
    const decoded = decodeURIComponent(href!);
    expect(decoded).toContain('BEGIN:VEVENT');
    expect(decoded).toContain('SUMMARY:Standup');
    expect(decoded).toContain('LOCATION:Zoom');
    expect(buildIcsHref({ title: 'x', startsAt: null })).toBeNull();
  });
});
