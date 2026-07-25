'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search, Sigma, X } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { Input } from '@mantle/web-ui/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mantle/web-ui/ui/select';
import { ListPager } from '@mantle/web-ui/layout/list-pager';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { TagPill } from '@mantle/web-ui/tag-pill';
import { useListNav } from '@/lib/use-list-nav';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { syncSelectionParam } from '@/lib/url-sync';
import { cn } from '@mantle/web-ui/lib/utils';
import type { CoverageGap, DimensionIssue, TargetSignature } from '@server/lib/formulas';
import { FormulaDetail, type FormulaRow } from './formula-detail';

type ListResponse = {
  formulas: FormulaRow[];
  total: number;
  page: number;
  pageSize: number;
  standards: string[];
};

type DetailResponse = {
  formula: FormulaRow;
  coverageGaps: CoverageGap[];
  dimensionIssues: DimensionIssue[];
  signature: TargetSignature[];
  specErrors?: string[];
};

/** Radix Select has no empty-string value, so "no filter" needs a sentinel. */
const ANY = '__any__';

export function FormulasClient() {
  const searchParams = useSearchParams();
  const { pending, go } = useListNav();

  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const query = searchParams.get('q')?.trim() ?? '';
  const standard = searchParams.get('standard')?.trim() ?? '';
  const tag = searchParams.get('tag')?.trim() ?? '';
  const urlId = searchParams.get('id')?.trim() || null;

  // Selection lives in client state, NOT read back off the URL. `select` mirrors
  // it to the address bar with history.replaceState, which deliberately performs
  // no navigation — so `useSearchParams` would never observe the change and the
  // list would not respond to a click. The URL param is therefore an entry point
  // (deep link, back/forward) rather than the source of truth.
  const [selectedId, setSelectedId] = useState<string | null>(urlId);
  useEffect(() => {
    if (urlId) setSelectedId(urlId);
  }, [urlId]);

  const [searchInput, setSearchInput] = useState(query);
  useEffect(() => setSearchInput(query), [query]);

  // Debounce the search box into the URL, which stays the source of truth.
  useEffect(() => {
    if (searchInput === query) return;
    const t = setTimeout(() => go({ q: searchInput || null, page: null }), 300);
    return () => clearTimeout(t);
  }, [searchInput, query, go]);

  const listQuery = useQuery({
    queryKey: ['formulas', { q: query, standard, tag, page }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      if (standard) qs.set('standard', standard);
      if (tag) qs.set('tag', tag);
      if (page > 1) qs.set('page', String(page));
      const suffix = qs.toString();
      return apiFetch<ListResponse>(`/api/formulas${suffix ? `?${suffix}` : ''}`);
    },
  });

  const formulas = useMemo(() => listQuery.data?.formulas ?? [], [listQuery.data]);
  const standards = useMemo(() => listQuery.data?.standards ?? [], [listQuery.data]);

  // Auto-select the first row, matching every other master-detail screen.
  const activeId = selectedId ?? formulas[0]?.id ?? null;

  const detailQuery = useQuery({
    queryKey: ['formula', activeId],
    queryFn: () => apiFetch<DetailResponse>(`/api/formulas/${activeId}`),
    enabled: Boolean(activeId),
  });

  function select(id: string) {
    setSelectedId(id);
    syncSelectionParam('id', id);
  }

  if (listQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (listQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">Could not load formulas.</p>
        <Button variant="outline" onClick={() => void listQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="relative md:grid md:h-full md:grid-cols-[360px_1fr] md:overflow-hidden">
      {/* ── Left: list ─────────────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="space-y-2 border-b border-border p-4">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search formulas…"
              className="pl-8"
            />
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={standard || ANY}
              onValueChange={(v) => go({ standard: v === ANY ? null : v, page: null })}
            >
              <SelectTrigger className="h-9 flex-1 text-xs">
                <SelectValue placeholder="Any standard" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any standard</SelectItem>
                {standards.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tag ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => go({ tag: null, page: null })}
                title="Clear the tag filter"
              >
                <X />
                {tag}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto scrollbar-thin p-3">
          {formulas.length === 0 ? (
            <p className="px-1 py-8 text-center text-sm text-muted-foreground">
              No formulas yet. Ask the assistant to transcribe one from a standard.
            </p>
          ) : (
            formulas.map((f) => (
              // The tags are filter buttons, so they sit OUTSIDE the row button
              // rather than inside it — a button nested in a button is invalid
              // and swallows the inner click in some browsers.
              <div
                key={f.id}
                className={cn(
                  'rounded-lg border border-l-[3px] border-border border-l-border bg-card',
                  activeId === f.id && 'border-l-primary',
                )}
              >
                <button
                  onClick={() => select(f.id)}
                  data-mark-id={f.id}
                  data-mark-kind="formula"
                  data-mark-label={f.title}
                  className="block w-full rounded-lg p-3 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-start gap-2">
                    <Sigma className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{f.title}</div>
                      {f.spec?.source?.standard ? (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {f.spec.source.standard}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </button>
                {f.tags.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3 pl-9">
                    {f.tags.map((t) => (
                      <button
                        key={t}
                        onClick={() => go({ tag: t === tag ? null : t, page: null })}
                        title={t === tag ? `Clear the ${t} filter` : `Show only ${t}`}
                      >
                        <TagPill
                          tag={t}
                          className={cn(
                            'transition-opacity hover:opacity-80',
                            t === tag && 'ring-1 ring-primary',
                          )}
                        />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>

        <ListPager
          page={page}
          total={listQuery.data?.total ?? 0}
          pageSize={listQuery.data?.pageSize ?? 50}
          pending={pending}
          onGo={(p) => go({ page: p > 1 ? p : null })}
        />
      </div>

      {/* ── Right: detail ──────────────────────────────────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-hidden">
        {detailQuery.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : detailQuery.data ? (
          <FormulaDetail
            // Remount per formula: the detail pane holds evaluator state
            // (chosen target, typed inputs, last result). Without this, switching
            // formulas would keep the previous one's inputs and show its result
            // under the new title — and the target id would name a target the
            // new spec may not even have.
            key={detailQuery.data.formula.id}
            formula={detailQuery.data.formula}
            coverageGaps={detailQuery.data.coverageGaps}
            dimensionIssues={detailQuery.data.dimensionIssues ?? []}
            signature={detailQuery.data.signature ?? []}
            specErrors={detailQuery.data.specErrors}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">Select a formula.</p>
          </div>
        )}
      </div>
    </div>
  );
}
