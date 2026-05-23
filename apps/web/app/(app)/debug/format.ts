import { formatDate } from '@/lib/format-datetime';

/** "YYYY-MM-DD HH:MM" from an ISO timestamp. */
export function fmtShort(iso: string): string {
  if (!iso) return '';
  return iso.slice(0, 16).replace('T', ' ');
}

/** "3m ago" / "2h ago" / "yesterday" / "5 days ago". */
export function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const now = Date.now();
  const secs = Math.max(1, Math.round((now - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return formatDate(iso);
}
