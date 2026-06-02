'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Pencil, Plus, Search, Table2, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useListNav } from '@/lib/use-list-nav';
import { useRealtime } from '@/components/realtime/use-realtime';
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
import type { TableRow, TableSort } from '@/lib/tables';

type Props = {
  tables: TableRow[];
  total: number;
  page: number;
  pageSize: number;
  tags: { tag: string; count: number }[];
  activeTag: string | null;
  query: string;
  sort: TableSort;
};

export function TablesClient(props: Props) {
  const { tables, total, page, pageSize, tags, activeTag, query } = props;
  const router = useRouter();
  const toast = useToast();
  const { pending: navPending, go } = useListNav();

  const [searchInput, setSearchInput] = useState(query);
  const [selectedId, setSelectedId] = useState<string | null>(tables[0]?.id ?? null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TableRow | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selected = useMemo(() => tables.find((t) => t.id === selectedId) ?? tables[0] ?? null, [tables, selectedId]);

  // Repaint when a table node changes anywhere (create/commit/delete).
  useRealtime(['table'], () => router.refresh());

  // Debounced search → URL.
  useEffect(() => {
    const h = setTimeout(() => {
      if (searchInput.trim() === query) return;
      go({ q: searchInput.trim() || null, page: 1 });
    }, 350);
    return () => clearTimeout(h);
  }, [searchInput]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (!res.ok) {
        toast.error('Could not create table');
        return;
      }
      const { table } = await res.json();
      router.push(`/tables/${table.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const res = await fetch(`/api/tables/${deleteTarget.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Could not delete table');
      return;
    }
    toast.success('Table deleted');
    setDeleteTarget(null);
    if (selectedId === deleteTarget.id) setSelectedId(null);
    router.refresh();
  }

  return (
    <div className="md:grid md:h-full md:min-h-0 md:grid-cols-[340px_1fr] md:overflow-hidden">
      {/* ── Left: list ──────────────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="space-y-3 border-b border-border p-3">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search tables…"
                className="pl-8"
              />
            </div>
            <Button onClick={() => { setNewTitle(''); setCreateOpen(true); }}>
              <Plus /> New
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

        <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {tables.length === 0 ? (
            <p className="px-1 py-8 text-center text-sm text-muted-foreground">No tables yet. Create one to get started.</p>
          ) : (
            tables.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={cn(
                  'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                  selected?.id === t.id && 'border-l-primary',
                )}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-base leading-none">{t.icon || '📊'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t.columnCount} {t.columnCount === 1 ? 'column' : 'columns'} · {t.rowCount} {t.rowCount === 1 ? 'row' : 'rows'}
                    </div>
                    {t.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {t.tags.map((tag) => (
                          <TagPill key={tag} tag={tag} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {total > pageSize && (
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{total} tables</span>
            <div className="flex items-center gap-1.5">
              <span className="tabular-nums">{page} / {totalPages}</span>
              <Button size="icon" variant="outline" className="size-7" disabled={page <= 1 || navPending} onClick={() => go({ page: page - 1 })} aria-label="Previous page">
                <ChevronLeft />
              </Button>
              <Button size="icon" variant="outline" className="size-7" disabled={page >= totalPages || navPending} onClick={() => go({ page: page + 1 })} aria-label="Next page">
                <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Right: preview ──────────────────────────────────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {selected ? (
          <div className="mx-auto max-w-2xl space-y-5 p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl leading-none">{selected.icon || '📊'}</span>
                <div>
                  <h2 className="text-lg font-semibold">{selected.title}</h2>
                  <p className="text-xs text-muted-foreground">
                    {selected.columnCount} columns · {selected.rowCount} rows · updated{' '}
                    {new Date(selected.updatedAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button asChild size="sm">
                  <Link href={`/tables/${selected.id}`}><Pencil /> Open editor</Link>
                </Button>
                <Button size="icon" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setDeleteTarget(selected)} aria-label="Delete table">
                  <Trash2 />
                </Button>
              </div>
            </div>

            {selected.summary ? (
              <p className="text-sm text-muted-foreground">{selected.summary}</p>
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Table2 className="size-4" aria-hidden /> Open the editor to view and edit the grid.
              </p>
            )}

            {selected.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selected.tags.map((tag) => (
                  <TagPill key={tag} tag={tag} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a table to preview.
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
            <SubmitButton onClick={() => void createTable()} pending={creating} disabled={!newTitle.trim()}>
              Create table
            </SubmitButton>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the table and its index entries. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void confirmDelete()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
