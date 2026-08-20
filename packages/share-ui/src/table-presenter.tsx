'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Calendar,
  CalendarClock,
  DollarSign,
  Hash,
  Link as LinkIcon,
  List,
  Loader2,
  Percent,
  SquareCheck,
  Tags,
  Type,
  Variable,
  type LucideIcon,
} from 'lucide-react';
import { AGGREGATE_KINDS, type AggregateKind } from '@mantle/content-core/table-model';
import { cn } from './lib/utils';
import { isEmbedded, type PresenterChrome } from './lib/presenter-chrome';

type CellValue = string | number | boolean | string[] | null;
type PublicRow = { id: string; cells: Record<string, CellValue> };
type PublicColumn = { id: string; name: string; type: string };
type PublicTab = {
  id: string;
  name: string;
  rowCount: number;
  columns: PublicColumn[];
  aggregates?: Record<string, AggregateKind>;
  aggregateValues?: Record<string, number | null>;
};

const PAGE = 200;

/** Header glyphs, the owner grid's map (table-grid.tsx) — the two surfaces
 *  should not disagree about what a currency column looks like. */
const TYPE_ICON: Record<string, LucideIcon> = {
  text: Type,
  number: Hash,
  currency: DollarSign,
  percent: Percent,
  date: Calendar,
  datetime: CalendarClock,
  checkbox: SquareCheck,
  select: List,
  multiselect: Tags,
  url: LinkIcon,
  formula: Variable,
  reference: ArrowUpRight,
};

const AGG_LABEL: Record<AggregateKind, string> = {
  none: 'None',
  sum: 'Sum',
  avg: 'Average',
  count: 'Count',
  min: 'Min',
  max: 'Max',
  empty: 'Empty',
  filled: 'Filled',
};

const NUMERIC_TYPES = new Set(['number', 'currency', 'percent', 'formula']);

/** Aggregate values are plain numbers by the time they reach here. An average
 *  keeps two decimals; everything else renders as a grouped integer-ish number,
 *  which is what a total of a currency or a count wants. */
function formatAggregate(value: number, kind: AggregateKind): string {
  if (kind === 'avg') return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * Read-only grid for a shared table.
 *
 * File-backed workbooks page their PUBLISHED rows through GET /s/[token]/rows;
 * legacy JSONB tables arrive whole in the share view and render inline. Raw
 * fetch on purpose: apiFetch is the app shell's authenticated wrapper. No edit
 * affordances of any kind — the server surface is read-only anyway; this
 * component simply has nothing to strip.
 *
 * ── Totals, and the one thing worth being careful about ────────────────────
 *
 * A footer total must never be computed from the rows this component happens to
 * be holding. It pages 200 at a time, so a client-side sum over a partial
 * window is not a smaller number — it is a WRONG one that looks exactly as
 * authoritative as a right one. So for a file-backed tab every total comes from
 * the server: the owner's presets ride in the share view already computed, and
 * a total the READER picks is fetched from /s/[token]/aggregate, which runs it
 * in SQL over every row.
 *
 * A legacy table is the exception, and only because it genuinely arrives whole:
 * there, `computeAggregate` over the doc in hand is the complete answer.
 *
 * A reader's own choice is view-local and never persisted. Nothing here writes;
 * reloading restores whatever the owner set.
 */
export function TablePresenter({
  view,
  token,
  chrome,
}: {
  view: {
    title: string;
    icon: string | null;
    tabs: PublicTab[] | null;
    legacyDoc: {
      columns: PublicColumn[];
      rows: PublicRow[];
      aggregates?: Record<string, AggregateKind>;
    } | null;
  };
  token: string;
  chrome?: PresenterChrome;
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

  /** The reader's own picks, per column — view-local, never sent anywhere that
   *  writes. Keyed per tab so switching tabs does not carry a choice across to
   *  a column that merely shares an id position. */
  const [readerAggs, setReaderAggs] = useState<Record<string, AggregateKind>>({});
  const [readerVals, setReaderVals] = useState<Record<string, number | null>>({});

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
      setReaderAggs({});
      setReaderVals({});
      void fetchPage(0, tab.id);
    }
    // Deliberately narrower than exhaustive-deps: refetch when the SELECTED TAB
    // changes, not when the tab object or `fetchPage` is re-created. `fetchPage`
    // is useCallback([token]) and a share page's token never changes, and `tab`
    // comes from a static view — so the wider deps would only ever cause a
    // redundant refetch that resets the reader's scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.id]);

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
    () => new Set(columns.filter((c) => NUMERIC_TYPES.has(c.type)).map((c) => c.id)),
    [columns],
  );

  /** The owner's presets for whatever is on screen. */
  const ownerAggs = view.legacyDoc ? (view.legacyDoc.aggregates ?? {}) : (tab?.aggregates ?? {});

  const kindFor = (colId: string): AggregateKind => readerAggs[colId] ?? ownerAggs[colId] ?? 'none';

  /**
   * The total to draw under a column, or null for "nothing to show".
   *
   * Three sources, and which one applies is entirely about whether the rows in
   * hand are the whole story:
   *  - legacy → compute locally; the doc IS complete.
   *  - a reader's pick on a file-backed tab → the value fetched for it.
   *  - otherwise → the owner's preset, computed server-side in the share view.
   */
  const valueFor = (colId: string): number | null => {
    const kind = kindFor(colId);
    if (kind === 'none') return null;
    if (view.legacyDoc) return legacyAggregate(view.legacyDoc.rows, colId, kind);
    if (colId in readerAggs) return readerVals[colId] ?? null;
    return tab?.aggregateValues?.[colId] ?? null;
  };

  const pickAggregate = async (colId: string, kind: AggregateKind) => {
    setReaderAggs((prev) => ({ ...prev, [colId]: kind }));
    if (kind === 'none' || view.legacyDoc || !tab) return;
    setReaderVals((prev) => ({ ...prev, [colId]: null }));
    try {
      const qs = new URLSearchParams({ tab: tab.id, col: colId, kind });
      const r = await fetch(`/s/${token}/aggregate?${qs.toString()}`, { cache: 'no-store' });
      if (!r.ok) return;
      const d = (await r.json()) as { value: number | null };
      setReaderVals((prev) => ({ ...prev, [colId]: d.value }));
    } catch {
      // A failed total stays blank. There is no honest fallback — the rows in
      // hand are a window, and a number from them would be wrong.
    }
  };

  const embedded = isEmbedded(chrome);
  const anyTotal = columns.some((c) => kindFor(c.id) !== 'none');

  const header = (
    <header className={embedded ? 'mb-3 shrink-0' : 'mb-6 shrink-0 text-center'}>
      {!embedded && (
        <h1 className="text-xl font-semibold tracking-tight">
          {view.icon ? `${view.icon} ` : ''}
          {view.title}
        </h1>
      )}
      <p className={cn('text-xs text-muted-foreground', !embedded && 'mt-1')}>
        {view.legacyDoc || !hasMore
          ? `${totalRows} row${totalRows === 1 ? '' : 's'}`
          : `${shownRows.length} of ${totalRows} rows`}
      </p>
    </header>
  );

  const tabStrip = tabs.length > 1 && (
    <div className="mb-3 flex shrink-0 flex-wrap gap-1">
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
  );

  const grid = (
    <table className="w-full border-collapse text-sm">
      {/* Sticky against the scroll box below, not the page: a grid whose
          headers leave the screen at row 40 is a grid of unlabelled numbers. */}
      <thead className="sticky top-0 z-10">
        <tr className="border-b border-border bg-muted">
          {columns.map((c) => {
            const Icon = TYPE_ICON[c.type] ?? Type;
            return (
              <th
                key={c.id}
                className={cn(
                  'whitespace-nowrap px-3 py-2 text-left font-medium text-muted-foreground',
                  numericCols.has(c.id) && 'text-right',
                )}
              >
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5',
                    numericCols.has(c.id) && 'flex-row-reverse',
                  )}
                >
                  <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
                  {c.name}
                </span>
              </th>
            );
          })}
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
      {/* Always rendered, even with nothing set: the row IS the affordance.
          A member who wants a total needs somewhere to ask for one, and a
          footer that appears only once the owner has already chosen leaves
          them no door. `bg-background` because a transparent sticky row shows
          the scrolling cells through itself. */}
      <tfoot className="sticky bottom-0 z-10">
        <tr className={cn('border-t-2 border-border bg-muted', !anyTotal && 'text-xs')}>
          {columns.map((c) => {
            const kind = kindFor(c.id);
            const value = valueFor(c.id);
            return (
              <td
                key={c.id}
                className={cn(
                  'border-l border-border/60 px-1.5 py-1 text-xs first:border-l-0',
                  numericCols.has(c.id) && 'text-right',
                )}
              >
                <label className="flex items-center justify-end gap-1.5">
                  <span className="sr-only">Total for {c.name}</span>
                  {kind !== 'none' && (
                    <span className="min-w-0 truncate font-medium tabular-nums">
                      {value === null ? (
                        // null is a real answer — "this column cannot be
                        // totalled that way". A 0 here would be a lie.
                        <span className="text-muted-foreground/50">—</span>
                      ) : (
                        formatAggregate(value, kind)
                      )}
                    </span>
                  )}
                  <select
                    value={kind}
                    onChange={(e) => void pickAggregate(c.id, e.target.value as AggregateKind)}
                    className={cn(
                      'cursor-pointer rounded-sm border-0 bg-transparent py-0 text-xs outline-none',
                      kind === 'none'
                        ? 'text-muted-foreground/60 hover:text-foreground'
                        : 'text-muted-foreground',
                    )}
                  >
                    {AGGREGATE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k === 'none' ? 'Σ' : AGG_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </label>
              </td>
            );
          })}
        </tr>
      </tfoot>
    </table>
  );

  const foot = (
    <>
      {loading && (
        <div className="flex shrink-0 items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden /> Loading…
        </div>
      )}
      {/* Auto-fetch rather than a "Load more" button: scrolling toward the end
          is already the gesture that means "show me the rest". */}
      {!loading && hasMore && tab && (
        <MoreSentinel onReveal={() => void fetchPage(shownRows.length, tab.id)} />
      )}
    </>
  );

  // Embedded, the grid OWNS the height it was given: the header and tab strip
  // are fixed, and the table scrolls inside a bounded box so its sticky header
  // and footer have something to stick to. On the standalone /s page there is
  // no height to own — the page scrolls, the table simply grows, and sticky
  // has nothing to do.
  if (embedded) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col px-6 py-6">
        {header}
        {tabStrip}
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border scrollbar-thin">
          {grid}
          {foot}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      {header}
      {tabStrip}
      <div className="overflow-x-auto rounded-lg border border-border">{grid}</div>
      {foot}
    </div>
  );
}

/**
 * The legacy path's total. Safe ONLY here: a legacy table's rows arrive whole
 * in the share view, so this is the complete set, not a window. Mirrors
 * computeAggregate's numeric semantics — non-numeric cells are ignored by the
 * numeric kinds rather than counted as zero.
 */
function legacyAggregate(rows: PublicRow[], colId: string, kind: AggregateKind): number | null {
  const isEmptyCell = (v: CellValue) =>
    v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  if (kind === 'count') return rows.length;
  if (kind === 'filled') return rows.filter((r) => !isEmptyCell(r.cells[colId] ?? null)).length;
  if (kind === 'empty') return rows.filter((r) => isEmptyCell(r.cells[colId] ?? null)).length;
  const nums = rows
    .map((r) => {
      const v = r.cells[colId];
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      return null;
    })
    .filter((n): n is number => n !== null);
  if (nums.length === 0) return null;
  switch (kind) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
    default:
      return null;
  }
}

/** Fetches the next page when it scrolls into view. */
function MoreSentinel({ onReveal }: { onReveal: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // The callback changes identity every render, so the observer reads it from a
  // ref — re-creating the observer each render would disconnect it mid-scroll
  // and the grid would stop growing until the reader scrolled again.
  const reveal = useRef(onReveal);
  reveal.current = onReveal;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries[0]?.isIntersecting && reveal.current(),
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return <div ref={ref} className="h-8 shrink-0" aria-hidden />;
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
        className="text-primary-ink underline underline-offset-2"
      >
        {value}
      </a>
    ) : (
      <>{value}</>
    );
  }
  return <>{String(value)}</>;
}
