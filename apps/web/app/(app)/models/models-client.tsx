'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Copy, ExternalLink, KeyRound, Loader2, RefreshCw, Search } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ListPager } from '@/components/layout/list-pager';
import { useListNav } from '@/lib/use-list-nav';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import type { ExplorerModel, ModelSort } from '@/lib/model-explorer';
import { copyText } from '@/lib/secure-context-fallbacks';

export type ProviderMeta = {
  id: string;
  label: string;
  description: string;
  signupUrl: string;
  docsUrl: string;
  isAggregator: boolean;
  canFetch: boolean;
};

type Meta = { needsKey: boolean; unsupported: boolean; error: string | null; fetchedAt: number };

const SORTS: { value: ModelSort; label: string }[] = [
  { value: 'name', label: 'Name (A→Z)' },
  { value: 'context', label: 'Context (high→low)' },
  { value: 'input', label: 'Input $ (low→high)' },
  { value: 'output', label: 'Output $ (low→high)' },
  { value: 'created', label: 'Newest' },
];

// ── formatters ───────────────────────────────────────────────────────────────

function fmtTokens(n?: number): string {
  if (n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
function fmtPrice(perM?: number): string {
  if (perM === undefined) return '—';
  if (perM === 0) return 'Free';
  if (perM < 0.01) return `$${perM.toFixed(4)}`;
  if (perM < 1) return `$${perM.toFixed(3)}`;
  return `$${perM.toFixed(2)}`;
}
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

// ── component ────────────────────────────────────────────────────────────────

type ExploreBundle = {
  providers: ProviderMeta[];
  provider: string;
  meta: Meta;
  rows: ExplorerModel[];
  total: number;
  page: number;
  pageSize: number;
  q: string;
  sort: ModelSort;
  kind: string;
  kinds: string[];
};

/** Outer query-gate so the page stays data-free. The URL params (kept by
 *  `useListNav`) key the query, so navigating refetches. */
export function ModelsClient({
  provider,
  q,
  sort,
  kind,
  page,
}: {
  provider: string;
  q: string;
  sort: string;
  kind: string;
  page: number;
}) {
  const exploreQuery = useQuery({
    queryKey: ['models', { provider, q, sort, kind, page }],
    queryFn: () => {
      const params = new URLSearchParams({ provider, sort, kind, page: String(page) });
      if (q) params.set('q', q);
      return apiFetch<ExploreBundle>(`/api/models/explore?${params.toString()}`);
    },
    placeholderData: (prev) => prev,
  });

  if (exploreQuery.isPending && !exploreQuery.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (exploreQuery.isError && !exploreQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>Couldn&apos;t load the model explorer.</p>
        <Button variant="outline" size="sm" onClick={() => exploreQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return <ModelsView data={exploreQuery.data} />;
}

function ModelsView({ data }: { data: ExploreBundle }) {
  const { providers, provider, meta, rows, total, page, pageSize, q, sort, kind, kinds } = data;
  const { pending: navPending, go } = useListNav();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState(q);
  const [selectedId, setSelectedId] = useState<string | null>(rows[0]?.id ?? null);
  const [refreshing, setRefreshing] = useState(false);

  // Re-select the first row whenever the SSR result changes (provider switch,
  // search, sort, page). Keeps the detail pane in sync with the visible page.
  useEffect(() => {
    setSelectedId((prev) => (prev && rows.some((r) => r.id === prev) ? prev : (rows[0]?.id ?? null)));
  }, [rows]);

  // Keep the search box in sync if the URL q changes from elsewhere.
  useEffect(() => setSearchInput(q), [q]);

  // Debounced URL-driven search (no client-side filtering of the loaded list).
  useEffect(() => {
    const h = setTimeout(() => {
      if (searchInput.trim() !== q) go({ q: searchInput.trim() || null, page: null });
    }, 350);
    return () => clearTimeout(h);
  }, [searchInput, q, go]);

  const current = providers.find((p) => p.id === provider);
  const selected = rows.find((m) => m.id === selectedId) ?? null;
  const busy = navPending || refreshing;

  const refresh = async () => {
    setRefreshing(true);
    try {
      // Bust the 5-min server cache, then refetch the explore bundle against it.
      const data = await apiFetch<{ models: unknown[] }>(
        `/api/models?provider=${encodeURIComponent(provider)}&refresh=1`,
      );
      toast.success(`Loaded ${data.models.length} model${data.models.length === 1 ? '' : 's'}`);
      await queryClient.invalidateQueries({ queryKey: ['models'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Refresh failed — network error');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="md:grid md:h-full md:grid-cols-[360px_1fr] md:overflow-hidden">
      {/* LEFT: provider picker + model list */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 border-b border-border p-3">
          <Select
            value={provider}
            onValueChange={(id) =>
              id !== provider && go({ provider: id, q: null, sort: null, kind: null, page: null })
            }
          >
            <SelectTrigger className="h-9 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                  {!p.canFetch && ' (no catalog)'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            className="size-9 shrink-0"
            onClick={refresh}
            disabled={busy}
            aria-label="Refresh model list"
          >
            {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>

        <div className="flex flex-col gap-2 border-b border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search models…"
              className="h-9 pl-8"
            />
          </div>
          <div className="flex items-center gap-2">
            <Select value={sort} onValueChange={(v) => go({ sort: v === 'name' ? null : v, page: null })}>
              <SelectTrigger className="h-8 flex-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {kinds.length > 1 && (
              <Select
                value={kind}
                onValueChange={(v) => go({ kind: v === 'all' ? null : v, page: null })}
              >
                <SelectTrigger className="h-8 w-[120px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {kinds.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {busy ? 'Loading…' : `${total} model${total === 1 ? '' : 's'} · updated ${timeAgo(meta.fetchedAt)}`}
          </p>
        </div>

        <div className="space-y-1.5 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {rows.length === 0 ? (
            <EmptyList meta={meta} provider={current} filtered={Boolean(q) || kind !== 'all'} />
          ) : (
            rows.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelectedId(m.id)}
                className={cn(
                  'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                  selectedId === m.id && 'border-l-primary',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{m.name ?? m.id}</span>
                  {m.kind && (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {m.kind}
                    </Badge>
                  )}
                </div>
                {m.name && <p className="truncate font-mono text-[11px] text-muted-foreground">{m.id}</p>}
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
                  <span>ctx {fmtTokens(m.contextTokens)}</span>
                  {(m.inputPricePerM !== undefined || m.outputPricePerM !== undefined) && (
                    <span>
                      in {fmtPrice(m.inputPricePerM)} · out {fmtPrice(m.outputPricePerM)} /M
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        <ListPager
          page={page}
          total={total}
          pageSize={pageSize}
          pending={navPending}
          onGo={(p) => go({ page: p > 1 ? p : null })}
        />
      </div>

      {/* RIGHT: detail */}
      <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {selected ? (
          <ModelDetail model={selected} provider={current} />
        ) : (
          <ProviderSplash meta={meta} provider={current} />
        )}
      </div>
    </div>
  );
}

// ── left-list empty/error/needs-key states ───────────────────────────────────

function EmptyList({
  meta,
  provider,
  filtered,
}: {
  meta: Meta;
  provider?: ProviderMeta;
  filtered: boolean;
}) {
  const box =
    'rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground';
  if (meta.needsKey)
    return <p className={box}>No API key for {provider?.label}. Add one to browse its models.</p>;
  if (meta.unsupported)
    return <p className={box}>{provider?.label} doesn’t expose a model catalog here.</p>;
  if (meta.error) return <p className={box}>Couldn’t load models.</p>;
  if (filtered) return <p className={box}>No models match.</p>;
  return <p className={box}>No models returned.</p>;
}

// ── right-pane splash (no model selected) ─────────────────────────────────────

function ProviderSplash({ meta, provider }: { meta: Meta; provider?: ProviderMeta }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      <Boxes className="size-8 text-muted-foreground" />
      {meta.needsKey ? (
        <>
          <p className="text-sm text-muted-foreground">
            No API key configured for <strong>{provider?.label}</strong>.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button asChild size="sm">
              <a href="/settings/keys">
                <KeyRound /> Add API key
              </a>
            </Button>
            {provider && (
              <Button asChild size="sm" variant="outline">
                <a href={provider.signupUrl} target="_blank" rel="noopener noreferrer">
                  Get a key <ExternalLink />
                </a>
              </Button>
            )}
          </div>
        </>
      ) : meta.unsupported ? (
        <p className="max-w-sm text-sm text-muted-foreground">
          {provider?.label} is a voice/transcription provider — it doesn’t publish an LLM-style
          model catalog through this explorer.
        </p>
      ) : meta.error ? (
        <>
          <p className="text-sm font-medium">Couldn’t load models</p>
          <p className="max-w-md break-words font-mono text-xs text-muted-foreground">{meta.error}</p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Select a model to see everything its API reports.</p>
      )}
    </div>
  );
}

// ── right-pane model detail ──────────────────────────────────────────────────

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

function ModelDetail({ model, provider }: { model: ExplorerModel; provider?: ProviderMeta }) {
  const toast = useToast();
  const rawJson = useMemo(() => JSON.stringify(model.raw, null, 2), [model.raw]);

  const copy = async (text: string, what: string) => {
    try {
      await copyText(text);
      toast.success(`Copied ${what}`);
    } catch {
      toast.error('Copy failed');
    }
  };

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{model.name ?? model.id}</h2>
          <button
            type="button"
            onClick={() => copy(model.id, 'model id')}
            className="group mt-0.5 flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground"
            title="Copy model id"
          >
            <span className="truncate">{model.id}</span>
            <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {model.kind && <Badge variant="secondary">{model.kind}</Badge>}
          {provider?.isAggregator && <Badge variant="outline">aggregator</Badge>}
        </div>
      </div>

      {model.description && <p className="text-sm text-muted-foreground">{model.description}</p>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Fact label="Context" value={fmtTokens(model.contextTokens)} />
        <Fact label="Max output" value={fmtTokens(model.maxOutputTokens)} />
        <Fact label="Modality" value={model.modality ?? '—'} />
        <Fact label="Input / 1M" value={fmtPrice(model.inputPricePerM)} />
        <Fact label="Output / 1M" value={fmtPrice(model.outputPricePerM)} />
        <Fact
          label="Released"
          value={model.created ? new Date(model.created).toLocaleDateString() : '—'}
        />
      </div>

      {model.extraPricing && model.extraPricing.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Other pricing
          </h3>
          <div className="flex flex-wrap gap-2">
            {model.extraPricing.map((p) => (
              <Badge key={p.label} variant="outline" className="font-mono text-[11px]">
                {p.label}: {p.value}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Raw API response
          </h3>
          <Button variant="ghost" size="sm" onClick={() => copy(rawJson, 'raw JSON')}>
            <Copy /> Copy
          </Button>
        </div>
        <pre className="max-h-[480px] overflow-auto rounded-lg border border-border bg-muted/40 p-4 font-mono text-[11px] leading-relaxed scrollbar-thin">
          {rawJson}
        </pre>
      </div>
    </div>
  );
}
