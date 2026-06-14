// Quiet hours (push-notifications.md §10) — enforced Mantle-side before a push
// goes out. `quietStart`/`quietEnd` are HH:MM in `timezone`; a window that ends
// before it starts wraps past midnight (e.g. 22:00 → 07:00).

export interface QuietHours {
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  timezone: string;
}

/** Minutes-since-midnight for `date` rendered in `timezone` (0–1439). */
function minutesInZone(date: Date, timezone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
  } catch {
    // Unknown timezone → fall back to UTC rather than throwing in the worker.
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
  }
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24; // '24:00' → 0
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

function parseHHMM(value: string): number {
  const [h, m] = value.split(':');
  return ((Number(h) || 0) % 24) * 60 + (Number(m) || 0);
}

/** True if `now` falls within the configured quiet window. */
export function isQuietNow(prefs: QuietHours, now: Date = new Date()): boolean {
  if (!prefs.quietEnabled) return false;
  const start = parseHHMM(prefs.quietStart);
  const end = parseHHMM(prefs.quietEnd);
  if (start === end) return false; // zero-length window = never quiet
  const cur = minutesInZone(now, prefs.timezone);
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}
