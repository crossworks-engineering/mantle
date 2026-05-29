import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { requireOwner } from '@/lib/auth';
import { formatDateTime } from '@/lib/format-datetime';
import { countTraces, formatDuration, formatMicroUsd, getTrace, listTraces } from '@/lib/traces';
import type { TraceSort, TraceSortDir } from '@/lib/traces-format';
import { SetPageTitle } from '@/components/layout/page-title';
import { Button } from '@/components/ui/button';
import { TraceDetailView } from './trace-detail-view';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<string, string> = {
  responder_turn: 'Responder',
  extractor_run: 'Extractor',
  summarizer_run: 'Summarizer',
  reflector_run: 'Reflector',
  content_ingest: 'Ingest',
  photo_ingest: 'Photo',
  heartbeat_fire: 'Heartbeat',
  federation_request: 'Federation',
  manual: 'Manual',
};

const KIND_OPTIONS: Array<[string, string]> = [
  ['responder_turn', 'Responder'],
  ['heartbeat_fire', 'Heartbeat'],
  ['extractor_run', 'Extractor'],
  ['summarizer_run', 'Summarizer'],
  ['reflector_run', 'Reflector'],
  ['content_ingest', 'Ingest'],
  ['photo_ingest', 'Photo'],
  ['federation_request', 'Federation'],
];

const STATUS_OPTIONS: Array<[string, string]> = [
  ['success', 'Success'],
  ['error', 'Error'],
  ['running', 'Running'],
  ['skipped', 'Skipped'],
];

const HOURS_OPTIONS: Array<[number, string]> = [
  [1, '1h'],
  [6, '6h'],
  [24, '24h'],
  [168, '7d'],
  [720, '30d'],
];

const SORT_OPTIONS: Array<{ sort: TraceSort; dir: TraceSortDir; label: string }> = [
  { sort: 'started', dir: 'desc', label: 'Newest' },
  { sort: 'started', dir: 'asc', label: 'Oldest' },
  { sort: 'cost', dir: 'desc', label: 'Costliest' },
  { sort: 'cost', dir: 'asc', label: 'Cheapest' },
  { sort: 'duration', dir: 'desc', label: 'Slowest' },
  { sort: 'duration', dir: 'asc', label: 'Fastest' },
];

/** Default view: completed runs + failures. Running/skipped are opt-in. */
const DEFAULT_STATUSES = ['success', 'error'];
const PAGE_SIZE = 50;

type SearchParams = {
  kind?: string | string[];
  status?: string | string[];
  hours?: string;
  sort?: string;
  dir?: string;
  page?: string;
  selected?: string;
};

export default async function TracesPage(props: { searchParams?: Promise<SearchParams> }) {
  const user = await requireOwner();
  const sp = (await props.searchParams) ?? {};

  const kinds = toArray(sp.kind);
  const statuses = toArray(sp.status);
  const hours = sp.hours ? parseInt(sp.hours, 10) : 24;
  const sort: TraceSort = sp.sort === 'cost' || sp.sort === 'duration' ? sp.sort : 'started';
  const dir: TraceSortDir = sp.dir === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const selected = sp.selected ?? null;
  const effectiveStatuses = statuses.length > 0 ? statuses : DEFAULT_STATUSES;

  const filter = {
    kinds: kinds.length > 0 ? kinds : undefined,
    statuses: effectiveStatuses,
    sinceHours: hours,
  };
  const [rows, total] = await Promise.all([
    listTraces(user.id, { ...filter, sort, dir, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countTraces(user.id, filter),
  ]);
  // Default the right pane to the first row when nothing is explicitly selected.
  const selectedId = selected ?? rows[0]?.id ?? null;
  const selectedTrace = selectedId ? await getTrace(user.id, selectedId) : null;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = kinds.length > 0 || statuses.length > 0 || hours !== 24;

  /** Build a /traces URL from the current state with overrides applied. */
  const href = (over: {
    kinds?: string[];
    statuses?: string[];
    hours?: number;
    sort?: TraceSort;
    dir?: TraceSortDir;
    page?: number;
    selected?: string | null;
  }) => {
    const n = { kinds, statuses, hours, sort, dir, page, selected, ...over };
    const p = new URLSearchParams();
    for (const k of n.kinds) p.append('kind', k);
    for (const s of n.statuses) p.append('status', s);
    if (n.hours !== 24) p.set('hours', String(n.hours));
    if (n.sort !== 'started') p.set('sort', n.sort);
    if (n.dir !== 'desc') p.set('dir', n.dir);
    if (n.page > 1) p.set('page', String(n.page));
    if (n.selected) p.set('selected', n.selected);
    const q = p.toString();
    return q ? `/traces?${q}` : '/traces';
  };

  return (
    <>
      <SetPageTitle title="Traces" />
      <div className="flex h-full flex-col overflow-hidden">
        {/* Filters + sort */}
        <div className="shrink-0 space-y-2 border-b border-border p-3">
          <FilterRow label="Status">
            {STATUS_OPTIONS.map(([value, label]) => (
              <FilterChip
                key={value}
                href={href({ statuses: toggle(effectiveStatuses, value), page: 1 })}
                active={effectiveStatuses.includes(value)}
              >
                {label}
              </FilterChip>
            ))}
          </FilterRow>
          <FilterRow label="Kind">
            {KIND_OPTIONS.map(([value, label]) => (
              <FilterChip
                key={value}
                href={href({ kinds: toggle(kinds, value), page: 1 })}
                active={kinds.includes(value)}
              >
                {label}
              </FilterChip>
            ))}
          </FilterRow>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <FilterRow label="Window">
              {HOURS_OPTIONS.map(([value, label]) => (
                <FilterChip key={value} href={href({ hours: value, page: 1 })} active={hours === value}>
                  {label}
                </FilterChip>
              ))}
            </FilterRow>
            <FilterRow label="Sort">
              {SORT_OPTIONS.map((o) => (
                <FilterChip
                  key={`${o.sort}-${o.dir}`}
                  href={href({ sort: o.sort, dir: o.dir, page: 1 })}
                  active={sort === o.sort && dir === o.dir}
                >
                  {o.label}
                </FilterChip>
              ))}
            </FilterRow>
            {hasFilters && (
              <Link
                href={href({ kinds: [], statuses: [], hours: 24 })}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Reset
              </Link>
            )}
          </div>
        </div>

        {/* Master-detail */}
        <div className="md:grid md:min-h-0 md:flex-1 md:grid-cols-[minmax(340px,400px)_1fr] md:overflow-hidden">
          {/* Left: trace cards */}
          <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
            <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
              {rows.length === 0 ? (
                <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-10 text-center text-sm text-muted-foreground">
                  No traces match these filters.
                </p>
              ) : (
                rows.map((r) => (
                  <Link
                    key={r.id}
                    href={href({ selected: r.id })}
                    className={cn(
                      'block rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 transition-colors hover:bg-accent/40',
                      selectedId === r.id && 'border-l-primary bg-accent/50',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span
                          className={cn('size-2 shrink-0 rounded-full', statusDot(r.status))}
                          aria-hidden
                        />
                        <span className="truncate text-sm font-medium">
                          {KIND_LABEL[r.kind] ?? r.kind}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 text-[10px] uppercase tracking-wider',
                            statusTextClass(r.status),
                          )}
                        >
                          {r.status}
                        </span>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatDateTime(r.startedAt)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
                      <span>{formatDuration(r.durationMs)}</span>
                      <span>{formatMicroUsd(r.costMicroUsd)}</span>
                      <span>
                        {r.tokensIn + r.tokensOut > 0 ? `${r.tokensIn + r.tokensOut}` : '—'} tok
                      </span>
                      <span>{r.stepCount} steps</span>
                    </div>
                    {r.error ? (
                      <div className="mt-0.5 truncate text-xs text-destructive">{r.error}</div>
                    ) : r.agentName ? (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {r.agentName}
                        {r.agentSlug ? ` / ${r.agentSlug}` : ''}
                      </div>
                    ) : null}
                  </Link>
                ))
              )}
            </div>
            {total > 0 && (
              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                <span className="tabular-nums">{total} traces</span>
                <div className="flex items-center gap-1.5">
                  <span className="tabular-nums">
                    {page} / {totalPages}
                  </span>
                  <PagerLink href={href({ page: page - 1 })} disabled={page <= 1} label="Previous page">
                    <ChevronLeft />
                  </PagerLink>
                  <PagerLink
                    href={href({ page: page + 1 })}
                    disabled={page >= totalPages}
                    label="Next page"
                  >
                    <ChevronRight />
                  </PagerLink>
                </div>
              </div>
            )}
          </div>

          {/* Right: detail */}
          <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
            {selectedTrace ? (
              <div className="p-6">
                <TraceDetailView trace={selectedTrace} />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
                Select a trace to view its steps.
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

function statusDot(status: string): string {
  if (status === 'success') return 'bg-emerald-500';
  if (status === 'error') return 'bg-destructive';
  if (status === 'skipped') return 'bg-muted-foreground/40';
  return 'bg-amber-500';
}

function statusTextClass(status: string): string {
  if (status === 'success') return 'text-emerald-700 dark:text-emerald-300';
  if (status === 'error') return 'text-destructive';
  if (status === 'skipped') return 'text-muted-foreground';
  return 'text-amber-700 dark:text-amber-300';
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 shrink-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </Link>
  );
}

function PagerLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <Button type="button" size="icon" variant="outline" className="size-7" disabled aria-label={label}>
        {children}
      </Button>
    );
  }
  return (
    <Button asChild size="icon" variant="outline" className="size-7">
      <Link href={href} aria-label={label}>
        {children}
      </Link>
    </Button>
  );
}
