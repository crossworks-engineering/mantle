import { cn } from '@mantle/web-ui/lib/utils';

export type VitalsLevel = 'unknown' | 'ok' | 'warn' | 'crit';

/**
 * Map a 0–100 fill to a semantic level. Shared so any bar/ring that follows
 * the vitals scheme escalates at the same thresholds.
 */
export function vitalsLevel(pct: number | null | undefined): VitalsLevel {
  if (pct == null || !Number.isFinite(pct)) return 'unknown';
  const c = Math.max(0, Math.min(100, pct));
  return c >= 90 ? 'crit' : c >= 75 ? 'warn' : 'ok';
}

/** Fill colours for the vitals scheme, keyed by level (literal classes so the
 *  Tailwind scanner keeps them). */
export const VITALS_FILL: Record<VitalsLevel, string> = {
  unknown: 'bg-muted-foreground/30',
  ok: 'bg-primary',
  warn: 'bg-amber-500',
  crit: 'bg-destructive',
};

/**
 * A simple labelled progress bar (no shadcn `progress` primitive exists).
 * Colour escalates with fill: primary → amber ≥75% → destructive ≥90%.
 * Shared by the System Vitals island (client) and Brain Stats (server) — no
 * 'use client' so it works in both.
 */
export function VitalsBar({
  pct,
  label,
  value,
  className,
}: {
  pct: number | null | undefined;
  label?: string;
  value?: string;
  className?: string;
}) {
  const known = pct != null && Number.isFinite(pct);
  const clamped = known ? Math.max(0, Math.min(100, pct)) : 0;
  const color = VITALS_FILL[vitalsLevel(pct)];
  return (
    <div className={cn('space-y-1', className)}>
      {(label || value) && (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          {label && <span className="text-muted-foreground">{label}</span>}
          <span className="font-medium tabular-nums">
            {value ?? (known ? `${clamped.toFixed(0)}%` : '—')}
          </span>
        </div>
      )}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all duration-500', color)}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
