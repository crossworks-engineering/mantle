/**
 * Pure, dependency-free byte/percent formatters. Safe to import from both
 * server and client components (no DB / Node-only deps), mirroring
 * `traces-format.ts`.
 */

/** Human-readable bytes, e.g. 1234567 → "1.2 MB". */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** A 0..1 ratio (or 0..100 already-percent) → "12%". Pass `already=true`
 *  when the input is already a 0..100 percentage. */
export function formatPct(value: number | null | undefined, already = false): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const pct = already ? value : value * 100;
  return `${pct.toFixed(pct >= 10 || pct === 0 ? 0 : 1)}%`;
}

/** Compact integer with thousands separators, e.g. 12345 → "12,345".
 *  Pins the `en-US` locale so server (Node) and client (browser) render the
 *  SAME separator — a bare `toLocaleString()` formats per the runtime's locale,
 *  which differs between Node and the browser (e.g. "1 931" vs "1,931") and
 *  causes a React hydration mismatch. */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

/** Seconds → "3d 4h", "5h 12m", "8m", "42s". For uptime display. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
