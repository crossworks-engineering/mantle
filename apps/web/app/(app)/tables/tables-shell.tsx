'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Loader2, PanelLeftClose, PanelLeftOpen, Plus, Search, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useListNav } from '@/lib/use-list-nav';
import { apiFetch } from '@/lib/api-fetch';
import { Spinner } from '@/components/ui/spinner';
import { useRealtime } from '@/components/realtime/use-realtime';
import { SetPageTitle } from '@/components/layout/page-title';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { TagPill } from '@/components/tag-pill';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { TableDetailClient } from './[id]/table-detail-client';
import type { TableDetail, TableRow, TableSort } from '@/lib/tables';

const MIN_W = 220;
const MAX_W = 520;
const DEFAULT_W = 320;

const SORTS: TableSort[] = ['edited', 'newest', 'oldest', 'title'];

type TablesListResponse = {
  tables: TableRow[];
  total: number;
  page: number;
  pageSize: number;
  tags: { tag: string; count: number }[];
};

export function TablesShell() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { pending: navPending, go } = useListNav();

  // URL is the source of truth (matches the old SSR page).
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const query = searchParams.get('q')?.trim() ?? '';
  const activeTag = searchParams.get('tag')?.trim() || null;
  const sortParam = searchParams.get('sort');
  const sort: TableSort = SORTS.includes(sortParam as TableSort) ? (sortParam as TableSort) : 'edited';

  const listQuery = useQuery({
    queryKey: ['tables', { q: query, tag: activeTag, sort, page }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      if (activeTag) qs.set('tag', activeTag);
      if (sort !== 'edited') qs.set('sort', sort);
      if (page > 1) qs.set('page', String(page));
      const s = qs.toString();
      return apiFetch<TablesListResponse>(`/api/tables${s ? `?${s}` : ''}`);
    },
    placeholderData: (prev) => prev,
  });

  const tables = listQuery.data?.tables ?? [];
  const total = listQuery.data?.total ?? 0;
  const pageSize = listQuery.data?.pageSize ?? 50;
  const tags = listQuery.data?.tags ?? [];

  // The full selected table (grid + draft) — a separate fetch since list rows
  // are summaries. Defaults to the first row (master-detail convention).
  const selectedId = (searchParams.get('selected')?.trim() || tables[0]?.id) ?? null;
  const selectedTableQuery = useQuery({
    queryKey: ['tables', selectedId],
    queryFn: () =>
      apiFetch<{ table: TableDetail }>(`/api/tables/${selectedId}`).then((r) => r.table),
    enabled: !!selectedId,
    placeholderData: (prev) => prev,
  });
  const selectedTable: TableDetail | null =
    selectedTableQuery.data?.id === selectedId ? selectedTableQuery.data : null;

  const [searchInput, setSearchInput] = useState(query);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TableRow | null>(null);

  const [listWidth, setListWidth] = useState(DEFAULT_W);
  const [collapsed, setCollapsed] = useState(false);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Which table is mid-open. Selecting is a server round-trip (the full grid is
  // loaded SSR), so without a cue the click feels dead for a beat. Set on click,
  // cleared once the new selection lands.
  const [pendingId, setPendingId] = useState<string | null>(null);
  useEffect(() => { setPendingId(null); }, [selectedId]);
  const selectTable = (id: string) => {
    if (id === selectedId) return;
    setPendingId(id);
    go({ selected: id });
  };

  // Restore persisted width + collapse after mount (avoids SSR hydration drift).
  useEffect(() => {
    const w = Number(localStorage.getItem('tables.listWidth'));
    if (w >= MIN_W && w <= MAX_W) setListWidth(w);
    setCollapsed(localStorage.getItem('tables.listCollapsed') === '1');
  }, []);

  useRealtime(['table'], () => {
    void queryClient.invalidateQueries({ queryKey: ['tables'] });
  });

  // Debounced search → URL.
  useEffect(() => {
    const h = setTimeout(() => {
      if (searchInput.trim() === query) return;
      go({ q: searchInput.trim() || null, page: 1 });
    }, 350);
    return () => clearTimeout(h);
  }, [searchInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { startX: e.clientX, startW: listWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const next = Math.min(MAX_W, Math.max(MIN_W, drag.current.startW + e.clientX - drag.current.startX));
    setListWidth(next);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    localStorage.setItem('tables.listWidth', String(listWidth));
  };

  const setCollapse = (v: boolean) => {
    setCollapsed(v);
    localStorage.setItem('tables.listCollapsed', v ? '1' : '0');
  };

  const openCreate = () => { setNewTitle(''); setCreateOpen(true); };

  async function createTable() {
    const title = newTitle.trim();
    if (!title) return;
    setCreating(true);
    try {
      const res = await fetch('/api/tables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) { toast.error('Could not create table'); return; }
      const { table } = await res.json();
      setCreateOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['tables'] });
      go({ selected: table.id });
    } finally {
      setCreating(false);
    }
  }

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/tables/${deleteTarget.id}`, { method: 'DELETE' });
    if (!res.ok) { toast.error('Could not delete table'); return; }
    toast.success('Table deleted');
    const wasSelected = deleteTarget.id === selectedId;
    setDeleteTarget(null);
    await queryClient.invalidateQueries({ queryKey: ['tables'] });
    if (wasSelected) go({ selected: null });
  }, [deleteTarget, selectedId, go, queryClient, toast]);

  if (listQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (listQuery.isError && !listQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-muted-foreground">
          {listQuery.error instanceof Error ? listQuery.error.message : 'Failed to load tables.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {collapsed ? (
        <div className="flex h-full w-11 shrink-0 flex-col items-center gap-1 border-r border-border py-2">
          <Button size="icon" variant="ghost" className="size-8" onClick={() => setCollapse(false)} aria-label="Show table list" title="Show tables">
            <PanelLeftOpen />
          </Button>
          <Button size="icon" variant="ghost" className="size-8" onClick={openCreate} aria-label="New table" title="New table">
            <Plus />
          </Button>
        </div>
      ) : (
        <div className="relative flex h-full shrink-0 flex-col border-r border-border" style={{ width: listWidth }}>
          <div className="space-y-3 border-b border-border p-3">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search tables…" className="h-8 pl-8" />
              </div>
              <Button size="icon" variant="ghost" className="size-8 shrink-0" onClick={openCreate} aria-label="New table" title="New table">
                <Plus />
              </Button>
              <Button size="icon" variant="ghost" className="size-8 shrink-0 text-muted-foreground" onClick={() => setCollapse(true)} aria-label="Collapse list" title="Collapse">
                <PanelLeftClose />
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.slice(0, 12).map((t) => (
                  <button
                    key={t.tag}
                    onClick={() => go({ tag: activeTag === t.tag ? null : t.tag, page: 1 })}
                    className={cn(
                      'rounded-md border border-border px-2 py-0.5 text-xs transition-colors hover:bg-muted/50',
                      activeTag === t.tag && 'border-primary bg-muted',
                    )}
                  >
                    {t.tag} <span className="text-muted-foreground">{t.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto scrollbar-thin p-2">
            {tables.length === 0 ? (
              <p className="px-1 py-10 text-center text-sm text-muted-foreground">No tables yet.</p>
            ) : (
              tables.map((t) => (
                <button
                  key={t.id}
                  onClick={() => selectTable(t.id)}
                  aria-busy={pendingId === t.id}
                  className={cn(
                    'group flex w-full items-start gap-2 rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                    selectedId === t.id && 'border-l-primary',
                    pendingId === t.id && 'border-l-primary',
                  )}
                >
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-base leading-none">
                    {pendingId === t.id ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden /> : (t.icon || '📊')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.title}</div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      Updated {new Date(t.updatedAt).toLocaleDateString()} · {t.columnCount} cols · {t.rowCount} rows
                    </div>
                    {t.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {t.tags.map((tag) => <TagPill key={tag} tag={tag} />)}
                      </div>
                    )}
                  </div>
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleteTarget(t); }}
                    className="shrink-0 self-center p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                    aria-label={`Delete ${t.title}`}
                    title="Delete table"
                  >
                    <Trash2 className="size-4" />
                  </span>
                </button>
              ))
            )}
          </div>

          {total > pageSize && (
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{total} tables</span>
              <div className="flex items-center gap-1.5">
                <span className="tabular-nums">{page} / {totalPages}</span>
                <Button size="icon" variant="outline" className="size-7" disabled={page <= 1 || navPending} onClick={() => go({ page: page - 1 })} aria-label="Previous page"><ChevronLeft /></Button>
                <Button size="icon" variant="outline" className="size-7" disabled={page >= totalPages || navPending} onClick={() => go({ page: page + 1 })} aria-label="Next page"><ChevronRight /></Button>
              </div>
            </div>
          )}

          {/* Drag handle on the right edge */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize table list"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="absolute inset-y-0 right-0 z-20 w-1.5 translate-x-1/2 cursor-col-resize transition-colors hover:bg-primary/20"
          />
        </div>
      )}

      {/* Right: the selected table's editor */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {selectedTable ? (
          <TableDetailClient key={selectedTable.id} initial={selectedTable} embedded />
        ) : selectedId && selectedTableQuery.isError ? (
          <>
            <SetPageTitle title="Tables" />
            <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-sm">
              <p className="text-muted-foreground">
                {selectedTableQuery.error instanceof Error
                  ? selectedTableQuery.error.message
                  : 'Failed to load table.'}
              </p>
              <Button variant="outline" size="sm" onClick={() => selectedTableQuery.refetch()}>
                Retry
              </Button>
            </div>
          </>
        ) : selectedId ? (
          <>
            <SetPageTitle title="Tables" />
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          </>
        ) : (
          <>
            <SetPageTitle title="Tables" />
            <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
              {tables.length === 0 ? 'Create a table to get started.' : 'Select a table.'}
            </div>
          </>
        )}
        {pendingId && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/60 backdrop-blur-[1px]">
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Loading table…
            </span>
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New table</DialogTitle>
            <DialogDescription>Give it a name. You can add columns and import a spreadsheet in the editor.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="e.g. Stock list"
            onKeyDown={(e) => { if (e.key === 'Enter') void createTable(); }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <SubmitButton onClick={() => void createTable()} pending={creating} disabled={!newTitle.trim()}>Create table</SubmitButton>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>This permanently removes the table and its index entries. This can’t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void confirmDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
