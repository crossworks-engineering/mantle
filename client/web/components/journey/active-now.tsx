'use client';

import Link from 'next/link';
import { Activity, AlertCircle, Loader2 } from 'lucide-react';
import { ActionIcon } from '@/components/journey/action-icon';
import {
  ageSeconds,
  relativeTime,
  STALL_THRESHOLD_S,
  useLiveActivity,
} from '@/components/journey/use-live-activity';

/**
 * Always-on live header for the Journey page: what's processing this second
 * (with stall detection) and anything that recently failed. Polls /api/activity
 * every 5s and pauses while the tab is hidden.
 */
export function ActiveNow() {
  const { data, loaded, tick } = useLiveActivity();
  void tick; // re-render cue for relative timestamps
  const active = data?.active ?? [];
  const failures = data?.failures ?? [];
  const live = active.length > 0;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <div className="flex items-center gap-2">
          <Activity
            className={
              'size-4 ' + (live ? 'animate-pulse text-emerald-500' : 'text-muted-foreground')
            }
            aria-hidden
          />
          <h2 className="text-sm font-semibold">Active now</h2>
          <span className="ml-auto text-xs text-muted-foreground">
            {!loaded ? '…' : live ? `${active.length} running` : 'idle'}
          </span>
        </div>
        {active.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {loaded ? 'Nothing processing right now.' : 'Checking…'}
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {active.map((it) => {
              const stalled = ageSeconds(it.startedAt) > STALL_THRESHOLD_S;
              return (
                <li key={it.traceId}>
                  <Link
                    href={`/debug/journey/${it.traceId}`}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-muted"
                  >
                    <Loader2
                      className={
                        'size-3.5 shrink-0 ' +
                        (stalled ? 'text-amber-500' : 'animate-spin text-emerald-500')
                      }
                      aria-hidden
                    />
                    <ActionIcon
                      iconKey={it.iconKey}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate">{it.label}</span>
                    {stalled ? (
                      <span className="ml-auto shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                        stalled · {relativeTime(it.startedAt)}
                      </span>
                    ) : (
                      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {relativeTime(it.startedAt)}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div
        className={
          'rounded-lg border p-3 ' +
          (failures.length > 0
            ? 'border-destructive/40 bg-destructive/5'
            : 'border-border bg-muted/20')
        }
      >
        <div className="flex items-center gap-2">
          <AlertCircle
            className={
              'size-4 ' + (failures.length > 0 ? 'text-destructive' : 'text-muted-foreground')
            }
            aria-hidden
          />
          <h2 className="text-sm font-semibold">Needs attention</h2>
          <span className="ml-auto text-xs text-muted-foreground">
            {!loaded ? '…' : failures.length > 0 ? `${failures.length} failed (24h)` : 'all clear'}
          </span>
        </div>
        {failures.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {loaded ? 'No failures in the last 24 hours.' : 'Checking…'}
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {failures.map((it) => (
              <li key={it.traceId}>
                <Link
                  href={`/debug/journey/${it.traceId}`}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-destructive/10"
                >
                  <ActionIcon iconKey={it.iconKey} className="size-3.5 shrink-0 text-destructive" />
                  <span className="truncate">{it.label}</span>
                  {it.title && (
                    <span className="truncate text-xs text-muted-foreground">— {it.title}</span>
                  )}
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {relativeTime(it.startedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
