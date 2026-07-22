'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search, Sigma } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ListPager } from '@/components/layout/list-pager';
import { Spinner } from '@/components/ui/spinner';
import { TagPill } from '@/components/tag-pill';
import { useListNav } from '@/lib/use-list-nav';
import { apiFetch } from '@/lib/api-fetch';
import { syncSelectionParam } from '@/lib/url-sync';
import { cn } from '@/lib/utils';
import type { CoverageGap } from '@/lib/formulas';
import { FormulaDetail, type FormulaRow } from './formula-detail';

type ListResponse = {
  formulas: FormulaRow[];
  total: number;
  page: number;
  pageSize: number;
};

type DetailResponse = { formula: FormulaRow; coverageGaps: CoverageGap[] };

export function FormulasClient() {
  const searchParams = useSearchParams();
  const { pending, go } = useListNav();

  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const query = searchParams.get('q')?.trim() ?? '';
  const selectedId = searchParams.get('id')?.trim() || null;

  const [searchInput, setSearchInput] = useState(query);
  useEffect(() => setSearchInput(query), [query]);

  // Debounce the search box into the URL, which stays the source of truth.
  useEffect(() => {
    if (searchInput === query) return;
    const t = setTimeout(() => go({ q: searchInput || null, page: null }), 300);
    return () => clearTimeout(t);
  }, [searchInput, query, go]);

  const listQuery = useQuery({
    queryKey: ['formulas', { q: query, page }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      if (page > 1) qs.set('page', String(page));
      const suffix = qs.toString();
      return apiFetch<ListResponse>(`/api/formulas${suffix ? `?${suffix}` : ''}`);
    },
  });

  const formulas = useMemo(() => listQuery.data?.formulas ?? [], [listQuery.data]);

  // Auto-select the first row, matching every other master-detail screen.
  const activeId = selectedId ?? formulas[0]?.id ?? null;

  const detailQuery = useQuery({
    queryKey: ['formula', activeId],
    queryFn: () => apiFetch<DetailResponse>(`/api/formulas/${activeId}`),
    enabled: Boolean(activeId),
  });

  function select(id: string) {
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
        <div className="border-b border-border p-4">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search formulas…"
              className="pl-8"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto scrollbar-thin p-3">
          {formulas.length === 0 ? (
            <p className="px-1 py-8 text-center text-sm text-muted-foreground">
              No formulas yet. Ask the assistant to transcribe one from a standard.
            </p>
          ) : (
            formulas.map((f) => (
              <button
                key={f.id}
                onClick={() => select(f.id)}
                data-mark-id={f.id}
                data-mark-kind="formula"
                data-mark-label={f.title}
                className={cn(
                  'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-3 text-left transition-colors hover:bg-muted/50',
                  activeId === f.id && 'border-l-primary',
                )}
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
                    {f.tags.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {f.tags.map((t) => (
                          <TagPill key={t} tag={t} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </button>
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
            formula={detailQuery.data.formula}
            coverageGaps={detailQuery.data.coverageGaps}
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
