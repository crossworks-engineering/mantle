import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { requireOwner } from '@/lib/auth';
import { formatDateTime } from '@/lib/format-datetime';
import { formatDuration, formatMicroUsd } from '@/lib/traces-format';
import { listActivity } from '@/lib/journey';
import { PIPELINE_LEGEND, type ActionCategory } from '@/lib/journey-format';
import { DebugTabs } from '../debug-tabs';
import { ActionIcon } from './action-icon';

/**
 * Journey view — Activity → Reaction. A feed of actions (you uploaded a PDF,
 * an email arrived, you chatted) each linking to the reaction story: the trace
 * step timeline + the brain layers it wrote. The human-readable companion to
 * the raw /debug operator view.
 */

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

export default async function JourneyPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; done?: string }>;
}) {
  const user = await requireOwner();
  const { cat, done } = await searchParams;
  const category = (['content', 'dialog', 'automation'] as const).find((c) => c === cat);
  const processedOnly = done === '1';
  const items = await listActivity(user.id, { category, processedOnly, limit: 100 });

  const buildHref = (nextCat: ActionCategory | 'all', nextDone: boolean) => {
    const sp = new URLSearchParams();
    if (nextCat !== 'all') sp.set('cat', nextCat);
    if (nextDone) sp.set('done', '1');
    const qs = sp.toString();
    return qs ? `/debug/journey?${qs}` : '/debug/journey';
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <DebugTabs />

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Journey</h1>
        <p className="text-sm text-muted-foreground">
          Every action you take, and how the brain reacted. Click a row to see the step-by-step
          digestion and which memory layers it wrote.
        </p>
      </header>

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
      {items.length === 0 ? (
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
                  {it.title && (
                    <p className="truncate text-xs text-muted-foreground">{it.title}</p>
                  )}
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
    </div>
  );
}
