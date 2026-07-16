import Link from 'next/link';
import { cn } from '@/lib/utils';

interface RowProps {
  id: string;
  fromAddr: string;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  internalDate: Date;
  isRead: boolean;
  selected: boolean;
  /** Pre-built URL preserving sort + other params; we only swap `email`. */
  href: string;
}

/**
 * Compact three-line row for the narrow inbox column. Selection highlight
 * + unread weight do the navigational work. Date is right-aligned next to
 * the sender so the row scans in a single eye sweep.
 */
export function EmailRow(props: RowProps) {
  const dateLabel = formatDate(props.internalDate);
  return (
    <Link
      href={props.href}
      className={cn(
        'block border-b border-border px-3 py-2.5 transition-colors',
        props.selected ? 'bg-accent' : 'hover:bg-accent/50',
      )}
      aria-current={props.selected ? 'true' : undefined}
    >
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'flex-1 truncate text-sm',
            props.isRead ? 'text-muted-foreground' : 'font-semibold text-foreground',
          )}
        >
          {props.fromName || props.fromAddr}
        </span>
        <time
          className="shrink-0 text-xs text-muted-foreground"
          dateTime={props.internalDate.toISOString()}
        >
          {dateLabel}
        </time>
      </div>
      <div className={cn('truncate text-sm', props.isRead ? 'text-foreground/80' : 'font-medium')}>
        {props.subject ?? '(no subject)'}
      </div>
      {props.snippet && (
        <div className="truncate text-xs text-muted-foreground">{props.snippet}</div>
      )}
    </Link>
  );
}

/** Today → "14:23", this year → "May 14", older → "May 14 2024". */
function formatDate(d: Date): string {
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
