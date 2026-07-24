'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { formatDateTime } from '@mantle/web-ui/lib/format-datetime';
import { formatDuration, formatMicroUsd } from '@/lib/traces-format';
import { PIPELINE_LEGEND, type ActionCategory } from '@/lib/journey-format';
import { ActionIcon } from '@/components/journey/action-icon';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import type { ActivityItem } from '@/lib/journey';

const CATS: { key: ActionCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'content', label: 'Content' },
  { key: 'dialog', label: 'Dialog' },
  { key: 'automation', label: 'Automation' },
];

const CATEGORY_DOT: Record<ActionCategory, string> = {
  content: 'bg-emerald-500',
  dialog: 'bg-sky-500',
  automation: 'bg-violet-500',
};

function statusPill(status: string): string {
  if (status === 'success') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (status === 'error') return 'bg-destructive/15 text-destructive';
  if (status === 'running') return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  return 'bg-muted text-muted-foreground';
}

/**
 * Data-free journey feed. The page hands the `cat`/`done` URL state; this
 * fetches the matching activity from GET /api/debug/journey. The category /
 * processed-only filters stay URL-driven `<Link>`s (nav → new props → refetch).
 */
export function JourneyClient({
  category,
  processedOnly,
}: {
  category?: ActionCategory;
  processedOnly: boolean;
}) {
  const journeyQuery = useQuery({
    queryKey: ['debug', 'journey', { category: category ?? 'all', processedOnly }],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (category) sp.set('cat', category);
      if (processedOnly) sp.set('done', '1');
      const qs = sp.toString();
      return apiFetch<{ items: ActivityItem[] }>(
        qs ? `/api/debug/journey?${qs}` : '/api/debug/journey',
      );
    },
    placeholderData: (prev) => prev,
  });

  const items = journeyQuery.data?.items ?? [];

  const buildHref = (nextCat: ActionCategory | 'all', nextDone: boolean) => {
    const sp = new URLSearchParams();
    if (nextCat !== 'all') sp.set('cat', nextCat);
    if (nextDone) sp.set('done', '1');
    const qs = sp.toString();
    return qs ? `/debug/journey?${qs}` : '/debug/journey';
  };

  return (
    <>
      {/* Pipeline legend — what lands where */}
      <div className="grid gap-2 sm:grid-cols-3">
        {PIPELINE_LEGEND.map((p) => (
          <div key={p.category} className="rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2">
              <span className={'h-2 w-2 rounded-full ' + CATEGORY_DOT[p.category]} />
              <h3 className="text-sm font-medium">{p.title}</h3>
            </div>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{p.flow}</p>
            <p className="mt-1 text-xs text-muted-foreground">{p.blurb}</p>
          </div>
        ))}
      </div>

      {/* Filters: pipeline category + a "did real work" toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {CATS.map((c) => {
            const active = (c.key === 'all' && !category) || c.key === category;
            return (
              <Link
                key={c.key}
                href={buildHref(c.key, processedOnly)}
                className={
                  'rounded-full border px-3 py-1 text-xs transition-colors ' +
                  (active
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground')
                }
              >
                {c.label}
              </Link>
            );
          })}
        </div>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <Link
          href={buildHref(category ?? 'all', !processedOnly)}
          title="Hide no-op skips (body_too_short, already_extracted, no_new_activity, …)"
          className={
            'rounded-full border px-3 py-1 text-xs transition-colors ' +
            (processedOnly
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:text-foreground')
          }
        >
          {processedOnly ? '✓ ' : ''}Processed only
        </Link>
      </div>

      {/* Feed */}
      {journeyQuery.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : journeyQuery.isError ? (
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          Couldn&apos;t load activity.
        </p>
      ) : items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No {processedOnly ? 'processed ' : ''}activity{category ? ` in “${category}”` : ''} yet
          {processedOnly ? ' — everything in range was a no-op skip.' : '.'} As you chat, upload, or
          receive email, actions will appear here.
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {items.map((it) => (
            <li key={it.traceId}>
              <Link
                href={`/debug/journey/${it.traceId}`}
                className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
              >
                <span
                  className={
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full ' +
                    CATEGORY_DOT[it.category] +
                    '/15'
                  }
                >
                  <ActionIcon iconKey={it.iconKey} className="h-4 w-4 text-foreground" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{it.label}</span>
                    <span
                      className={
                        'rounded px-1.5 py-0.5 text-[10px] font-medium ' + statusPill(it.status)
                      }
                    >
                      {it.status}
                    </span>
                  </div>
                  {it.title && <p className="truncate text-xs text-muted-foreground">{it.title}</p>}
                </div>
                <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground sm:block">
                  <div title={formatDateTime(it.startedAt)}>
                    {new Date(it.startedAt).toLocaleString()}
                  </div>
                  <div className="font-mono">
                    {it.stepCount} steps · {formatDuration(it.durationMs)} ·{' '}
                    {formatMicroUsd(it.costMicroUsd)}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
