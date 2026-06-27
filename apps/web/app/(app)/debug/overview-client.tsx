'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { formatDateTime } from '@/lib/format-datetime';
import { formatDuration, formatMicroUsd } from '@/lib/traces-format';
import { Spinner } from '@/components/ui/spinner';
import type { ContentIndexCoverage, DuplicateEdgeStats } from '@/lib/debug';
import type {
  AgentSpend,
  CacheHitStats,
  DailySpend,
  DuplicateSuppression,
  FactCostCapStats,
  RecentFailure,
  TopError,
  Traffic,
} from '@/lib/metrics';

type OverviewData = {
  traffic24h: Traffic;
  spend7d: AgentSpend[];
  cache7d: CacheHitStats;
  errors7d: TopError[];
  recentFails: RecentFailure[];
  daily14d: DailySpend[];
  dupes: DuplicateEdgeStats;
  coverage: ContentIndexCoverage;
  dupCalls7d: DuplicateSuppression[];
  factCap7d: FactCostCapStats[];
};

/** Data-free Debug overview: fetches the whole health bundle from
 *  GET /api/debug/overview and renders the dashboard. */
export function OverviewClient() {
  const overviewQuery = useQuery({
    queryKey: ['debug', 'overview'],
    queryFn: () => apiFetch<OverviewData>('/api/debug/overview'),
  });

  if (overviewQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (overviewQuery.isError && !overviewQuery.data) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
        Couldn&apos;t load the debug overview.
      </p>
    );
  }

  const {
    traffic24h,
    spend7d,
    cache7d,
    errors7d,
    recentFails,
    daily14d,
    dupes,
    coverage,
    dupCalls7d,
    factCap7d,
  } = overviewQuery.data;

  const dupCallTotal = dupCalls7d.reduce((a, b) => a + b.count, 0);
  const factCapDropped = factCap7d.reduce((a, b) => a + b.factsDropped, 0);
  const maxDaily = daily14d.reduce((m, d) => Math.max(m, d.costMicroUsd), 0);
  const totalSpend = spend7d.reduce((sum, r) => sum + r.costMicroUsd, 0);
  const cacheTotal = cache7d.hits + cache7d.misses;
  const cachePct = cacheTotal > 0 ? (cache7d.hits / cacheTotal) * 100 : 0;
  const successRate24 =
    traffic24h.count > 0
      ? ((traffic24h.count - traffic24h.errorCount) / traffic24h.count) * 100
      : 100;

  return (
    <>
      {/* ─── Dashboard widgets ──────────────────────────────────────────── */}
      <section className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        <StatCard
          title="Last 24h"
          primary={`${traffic24h.count} traces`}
          secondary={
            traffic24h.count === 0
              ? '—'
              : `${successRate24.toFixed(0)}% success · avg ${formatDuration(traffic24h.avgMs)}`
          }
          accent={traffic24h.errorCount > 0 ? 'amber' : 'emerald'}
        />
        <StatCard
          title="Token spend (7d)"
          primary={formatMicroUsd(totalSpend)}
          secondary={
            spend7d.length === 0
              ? '—'
              : spend7d
                  .slice(0, 2)
                  .map((a) => `${a.agentName ?? 'unknown'}: ${formatMicroUsd(a.costMicroUsd)}`)
                  .join(' · ')
          }
        />
        <StatCard
          title="Embed cache (7d)"
          primary={cacheTotal === 0 ? '—' : `${cachePct.toFixed(0)}% hit`}
          secondary={
            cacheTotal === 0
              ? 'no embed activity'
              : `${cache7d.hits} hits · ${cache7d.misses} misses · ${cache7d.apiCalls} api calls`
          }
        />
        <StatCard
          title="Failures (7d)"
          primary={`${errors7d.reduce((a, b) => a + b.count, 0)}`}
          secondary={
            errors7d.length === 0
              ? 'all clean'
              : `${errors7d.length} distinct error${errors7d.length === 1 ? '' : 's'}`
          }
          accent={errors7d.length > 0 ? 'red' : 'emerald'}
        />
        <StatCard
          title="Duplicate edges"
          primary={dupes.redundant === 0 ? 'clean' : `${dupes.redundant}`}
          secondary={
            dupes.redundant === 0
              ? 'no duplicates'
              : `${dupes.groups} link${dupes.groups === 1 ? '' : 's'} · run pnpm dedupe:edges`
          }
          accent={dupes.redundant > 0 ? 'amber' : 'emerald'}
        />
      </section>

      {/* ─── Duplicate edges (historical) ───────────────────────────────── */}
      {dupes.redundant > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Duplicate edges
          </h2>
          <p className="text-sm text-muted-foreground">
            {dupes.groups} duplicated link{dupes.groups === 1 ? '' : 's'} · {dupes.redundant}{' '}
            redundant row{dupes.redundant === 1 ? '' : 's'}. These predate the idempotent-extractor
            fix; clean them with{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              pnpm dedupe:edges --apply
            </code>
            .
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {dupes.samples.map((s, i) => (
              <li key={i} className="flex items-baseline gap-3 px-3 py-2 text-sm">
                <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                  ×{s.count}
                </span>
                <span className="shrink-0 text-xs uppercase tracking-wider text-muted-foreground">
                  {s.relation}
                </span>
                <span className="min-w-0 truncate">{s.label}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ─── Duplicate tool calls suppressed (7d) ───────────────────────── */}
      {dupCallTotal > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Duplicates suppressed (7d)
            </h2>
            <span className="text-xs text-muted-foreground">
              {dupCallTotal} tool call{dupCallTotal === 1 ? '' : 's'}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Models that emit byte-identical parallel <code>tool_use</code> blocks for the same write
            — only the first is dispatched, duplicates are suppressed. A high count here = the model
            is misbehaving; an empty list = the guard never had to fire. See{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">architecture.md §9n</code>.
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {dupCalls7d.map((d) => (
              <li key={d.model} className="flex items-baseline gap-3 px-3 py-2 text-sm">
                <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                  ×{d.count}
                </span>
                <code className="shrink-0 font-mono text-xs">{d.model}</code>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {d.topSlugs}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDateTime(d.lastAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ─── Facts dropped to cost cap (7d) ──────────────────────────────── */}
      {factCapDropped > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Facts dropped to cost cap (7d)
            </h2>
            <span className="text-xs text-muted-foreground">
              {factCapDropped} fact{factCapDropped === 1 ? '' : 's'}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Extractor runs whose per-node fact budget (<code>extract_cost_cap_micro_usd</code>) was
            exhausted — the model produced these facts, but they were discarded before reaching your
            profile. A non-zero count usually means the cap is set too low (a cap of <code>0</code>{' '}
            means unlimited). Re-fire the node after raising it to recover them. See{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              data-flow-tracing.md §4
            </code>
            .
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {factCap7d.map((f) => (
              <li key={f.model} className="flex items-baseline gap-3 px-3 py-2 text-sm">
                <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                  −{f.factsDropped}
                </span>
                <code className="shrink-0 font-mono text-xs">{f.model}</code>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {f.runs} run{f.runs === 1 ? '' : 's'}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDateTime(f.lastAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ─── Top errors ─────────────────────────────────────────────────── */}
      {errors7d.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Top errors (7d)
          </h2>
          <ul className="divide-y divide-border rounded-md border border-border">
            {errors7d.map((e) => (
              <li key={e.message} className="flex items-baseline gap-3 px-3 py-2 text-sm">
                <span className="rounded-md bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                  ×{e.count}
                </span>
                <span className="flex-1 truncate">{e.message}</span>
                <Link
                  href={`/traces/${e.lastTraceId}`}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  {formatDateTime(e.lastAt)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ─── Recent failures ────────────────────────────────────────────── */}
      {recentFails.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Recent failed traces
          </h2>
          <ul className="divide-y divide-border rounded-md border border-border">
            {recentFails.map((f) => (
              <li key={f.id} className="flex items-baseline gap-3 px-3 py-2 text-sm">
                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                  {f.kind}
                </span>
                <Link
                  href={`/traces/${f.id}`}
                  className="flex-1 truncate text-destructive hover:underline"
                >
                  {f.error.slice(0, 120)}
                </Link>
                <span className="text-xs text-muted-foreground">{formatDateTime(f.startedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ─── Daily spend (14d) ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Daily spend (14d)
          </h2>
          <span className="text-xs text-muted-foreground">
            {formatMicroUsd(daily14d.reduce((s, d) => s + d.costMicroUsd, 0))} total
          </span>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="flex h-32 items-end gap-1">
            {daily14d.map((d) => {
              const heightPct = maxDaily > 0 ? (d.costMicroUsd / maxDaily) * 100 : 0;
              const today = d.day === new Date().toISOString().slice(0, 10);
              return (
                <div
                  key={d.day}
                  className="group relative min-w-0 flex-1"
                  title={`${d.day} — ${formatMicroUsd(d.costMicroUsd)} · ${d.runs} runs · ${d.tokensIn + d.tokensOut} tok`}
                >
                  <div
                    className={`w-full rounded-t-sm ${today ? 'bg-emerald-500/70' : 'bg-emerald-500/30'} group-hover:bg-emerald-500/80`}
                    style={{ height: `${Math.max(heightPct, d.costMicroUsd > 0 ? 4 : 0)}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>{daily14d[0]?.day.slice(5)}</span>
            <span>{daily14d[daily14d.length - 1]?.day.slice(5)}</span>
          </div>
        </div>
      </section>

      {/* ─── Content index coverage ────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Content index coverage
        </h2>
        <div className="rounded-md border border-border p-3 text-sm">
          {coverage.total === 0 ? (
            <p className="text-muted-foreground">No content nodes yet.</p>
          ) : (
            <>
              <div className="flex items-baseline justify-between">
                <span>
                  <strong>{coverage.indexed}</strong> / {coverage.total} indexed{' '}
                  <span className="text-muted-foreground">
                    ({((coverage.indexed / Math.max(1, coverage.total)) * 100).toFixed(0)}%)
                  </span>
                </span>
                {coverage.indexed < coverage.total && (
                  <span className="text-xs text-amber-700 dark:text-amber-300">
                    Run <code>pnpm extract:backfill</code> to catch up.
                  </span>
                )}
              </div>
              <ul className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                {coverage.byType.map((row) => {
                  const pct = (row.indexed / Math.max(1, row.total)) * 100;
                  return (
                    <li key={row.type} className="flex items-baseline justify-between gap-3">
                      <span>
                        <code className="font-mono">{row.type}</code> · <strong>{row.indexed}</strong>
                        /{row.total}
                      </span>
                      <span className={pct === 100 ? 'text-emerald-700 dark:text-emerald-300' : ''}>
                        {pct.toFixed(0)}%
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </section>
    </>
  );
}

function StatCard({
  title,
  primary,
  secondary,
  accent,
}: {
  title: string;
  primary: string;
  secondary: string;
  accent?: 'emerald' | 'amber' | 'red';
}) {
  const accentClass =
    accent === 'red'
      ? 'border-destructive/30 bg-destructive/5'
      : accent === 'amber'
        ? 'border-amber-400/40 bg-amber-100/30 dark:bg-amber-900/20'
        : 'border-border';
  return (
    <div className={`rounded-md border ${accentClass} p-3`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{primary}</div>
      <div className="text-xs text-muted-foreground">{secondary}</div>
    </div>
  );
}
