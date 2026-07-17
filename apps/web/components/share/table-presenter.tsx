'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type CellValue = string | number | boolean | string[] | null;
type PublicRow = { id: string; cells: Record<string, CellValue> };
type PublicColumn = { id: string; name: string; type: string };
type PublicTab = { id: string; name: string; rowCount: number; columns: PublicColumn[] };

const PAGE = 200;

/**
 * Public read-only grid for a shared table. File-backed workbooks page their
 * PUBLISHED rows through GET /s/[token]/rows (offset windows, "Load more");
 * legacy JSONB tables arrive whole in the share view and render inline.
 * Raw fetch on purpose: apiFetch is the app shell's authenticated wrapper.
 * No edit affordances of any kind — the server surface is read-only anyway;
 * this component simply has nothing to strip.
 */
export function TablePresenter({
  view,
  token,
}: {
  view: {
    title: string;
    icon: string | null;
    tabs: PublicTab[] | null;
    legacyDoc: { columns: PublicColumn[]; rows: PublicRow[] } | null;
  };
  token: string;
}) {
  const tabs = view.tabs ?? [];
  const [tabId, setTabId] = useState<string | null>(tabs[0]?.id ?? null);
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0] ?? null;

  const [rows, setRows] = useState<PublicRow[]>([]);
  // Seeded from the tab's registry count so the header is accurate before the
  // first row page lands (and after a failed fetch); the server total from
  // each successful page overrides it.
  const [total, setTotal] = useState(tabs[0]?.rowCount ?? 0);
  const [loading, setLoading] = useState(!!tab);
  const [failed, setFailed] = useState(false);
  // Tab-switch race guard: a stale page for the previous tab must not land.
  const reqSeq = useRef(0);

  const fetchPage = useCallback(
    async (offset: number, forTab: string) => {
      const seq = ++reqSeq.current;
      setLoading(true);
      setFailed(false);
      try {
        const r = await fetch(
          `/s/${token}/rows?tab=${encodeURIComponent(forTab)}&offset=${offset}&limit=${PAGE}`,
          { cache: 'no-store' },
        );
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as { rows: PublicRow[]; total: number; offset: number };
        if (seq !== reqSeq.current) return;
        setRows((prev) => (offset === 0 ? d.rows : [...prev, ...d.rows]));
        setTotal(d.total);
      } catch {
        if (seq === reqSeq.current) setFailed(true);
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    if (tab) {
      setRows([]);
      setTotal(tab.rowCount);
      void fetchPage(0, tab.id);
    }
  }, [tab?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Memoized so the `?? []` fallback doesn't mint a fresh array each render and
  // re-run the numericCols useMemo below (react-hooks/exhaustive-deps).
  const columns = useMemo(
    () => (view.legacyDoc ? view.legacyDoc.columns : (tab?.columns ?? [])),
    [view.legacyDoc, tab?.columns],
  );
  const shownRows = view.legacyDoc ? view.legacyDoc.rows : rows;
  const totalRows = view.legacyDoc ? view.legacyDoc.rows.length : total;
  const hasMore = !view.legacyDoc && shownRows.length < totalRows;

  const numericCols = useMemo(
    () =>
      new Set(columns.filter((c) => c.type === 'number' || c.type === 'currency').map((c) => c.id)),
    [columns],
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-6 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          {view.icon ? `${view.icon} ` : ''}
          {view.title}
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {totalRows} row{totalRows === 1 ? '' : 's'}
        </p>
      </header>

      {tabs.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTabId(t.id)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                t.id === (tab?.id ?? null)
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {columns.map((c) => (
                <th
                  key={c.id}
                  className={cn(
                    'whitespace-nowrap px-3 py-2 text-left font-medium text-muted-foreground',
                    numericCols.has(c.id) && 'text-right',
                  )}
                >
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownRows.map((r) => (
              <tr key={r.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                {columns.map((c) => (
                  <td
                    key={c.id}
                    className={cn(
                      'max-w-96 truncate px-3 py-1.5',
                      numericCols.has(c.id) && 'text-right tabular-nums',
                    )}
                  >
                    <Cell value={r.cells[c.id] ?? null} type={c.type} />
                  </td>
                ))}
              </tr>
            ))}
            {shownRows.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={Math.max(columns.length, 1)}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  {failed ? 'Could not load rows.' : 'No rows.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-center gap-3">
        {loading && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden /> Loading…
          </span>
        )}
        {!loading && hasMore && tab && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchPage(shownRows.length, tab.id)}
          >
            <Table2 /> Load more ({shownRows.length} of {totalRows})
          </Button>
        )}
      </div>
    </div>
  );
}

function Cell({ value, type }: { value: CellValue; type: string }) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground/50">—</span>;
  }
  if (type === 'checkbox' || typeof value === 'boolean') {
    return <span>{value ? '✓' : '—'}</span>;
  }
  if (Array.isArray(value)) return <>{value.join(', ')}</>;
  if (type === 'url' && typeof value === 'string') {
    const href = /^https?:\/\//i.test(value) ? value : null;
    return href ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2"
      >
        {value}
      </a>
    ) : (
      <>{value}</>
    );
  }
  return <>{String(value)}</>;
}
