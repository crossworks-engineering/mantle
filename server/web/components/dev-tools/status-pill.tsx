import { cn } from '@mantle/web-ui/lib/utils';

/** Status-code pill + the request meta line (duration, size). */
export function StatusPill({ status, statusText }: { status: number; statusText: string }) {
  const cls =
    status === 0
      ? 'bg-muted text-muted-foreground'
      : status < 300
        ? 'bg-chart-2/15 text-chart-2'
        : status < 500
          ? 'bg-chart-3/15 text-chart-3'
          : 'bg-destructive/15 text-destructive';
  return (
    <span className={cn('rounded-md px-2 py-0.5 font-mono text-xs font-semibold', cls)}>
      {status === 0 ? 'ERR' : status} {statusText}
    </span>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
