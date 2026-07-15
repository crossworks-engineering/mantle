'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Check, GitCommitHorizontal, Loader2, Trash2, Undo2, Upload } from 'lucide-react';
import { BackLink } from '@/components/layout/back-link';
import { SetPageTitle } from '@/components/layout/page-title';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
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
import { ExportButton } from '@/components/export/export-button';
import { TableGrid } from '@/components/table-grid/table-grid';
import { useSurfaceAssist } from '@/components/assistant/use-surface-assist';
import { ensureTableDoc, type TableDoc } from '@mantle/content/table-model';
import { apiFetch, apiSend, ApiError } from '@/lib/api-fetch';
import type { TableDetail } from '@/lib/tables';

const DRAFT_DEBOUNCE_MS = 1200;
const META_DEBOUNCE_MS = 800;

export function TableDetailClient({ initial, embedded = false }: { initial: TableDetail; embedded?: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();

  const published = ensureTableDoc(initial.data);
  const [doc, setDoc] = useState<TableDoc>(ensureTableDoc(initial.draft ?? initial.data));
  const [title, setTitle] = useState(initial.title);
  const [icon, setIcon] = useState(initial.icon ?? '');
  const [committing, setCommitting] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const docRef = useRef(doc);
  docRef.current = doc;
  const committedRef = useRef(JSON.stringify(published));
  const draftSavedRef = useRef(JSON.stringify(initial.draft ?? initial.data));
  const metaSavedRef = useRef(initial.title);
  const iconSavedRef = useRef(initial.icon ?? '');
  const fileRef = useRef<HTMLInputElement>(null);

  // Past the materialize window the grid shows a leading window of the rows
  // (read-only — a whole-doc edit of a window would truncate the table; the
  // assistant's row tools edit at any size) and pages the rest in on demand.
  const clipped = initial.docClipped === true;
  const [loadedTotal, setLoadedTotal] = useState(initial.rowCount);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const draftParam = initial.draft != null ? '&draft=1' : '';
      const page = await apiFetch<{ rows: TableDoc['rows']; total: number }>(
        `/api/tables/${initial.id}/rows?offset=${docRef.current.rows.length}&limit=1000${draftParam}`,
      );
      setLoadedTotal(page.total);
      if (page.rows.length > 0) {
        setDoc((d) => ({ ...d, rows: [...d.rows, ...page.rows] }));
        // Appending display rows must not trip the autosave differ.
        draftSavedRef.current = '';
      }
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) toast.error('Could not load more rows');
    } finally {
      setLoadingMore(false);
    }
  }, [initial.draft, initial.id, loadingMore, toast]);

  const dirty = !clipped && JSON.stringify(doc) !== committedRef.current;

  // ── Autosave the working grid to draft_data (no publish, no index). ──
  const saveDraft = useCallback(async () => {
    if (clipped) return; // read-only window — nothing autosaves
    const s = JSON.stringify(docRef.current);
    if (s === draftSavedRef.current) return;
    setDraftSaving(true);
    try {
      await apiSend(`/api/tables/${initial.id}/draft`, 'PUT', { data: docRef.current });
      draftSavedRef.current = s;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast.error('Could not save draft');
      return;
    } finally {
      setDraftSaving(false);
    }
  }, [initial.id, toast]);

  // Debounced draft autosave whenever the grid changes.
  useEffect(() => {
    if (clipped) return;
    const s = JSON.stringify(doc);
    if (s === draftSavedRef.current) return;
    const h = setTimeout(() => void saveDraft(), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [clipped, doc, saveDraft]);

  // Title saves live (cheap metadata; never indexes).
  useEffect(() => {
    if (title === metaSavedRef.current) return;
    const h = setTimeout(async () => {
      try {
        await apiSend(`/api/tables/${initial.id}`, 'PATCH', { title: title.trim() || 'Untitled table' });
        metaSavedRef.current = title;
      } catch {
        // metadata autosave is best-effort; the next edit retries.
      }
    }, META_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [title, initial.id]);

  // Icon (emoji) saves live, same as the title.
  useEffect(() => {
    if (icon === iconSavedRef.current) return;
    const h = setTimeout(async () => {
      try {
        await apiSend(`/api/tables/${initial.id}`, 'PATCH', { icon: icon.trim() });
        iconSavedRef.current = icon;
      } catch {
        // metadata autosave is best-effort; the next edit retries.
      }
    }, META_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [icon, initial.id]);

  // ── Commit: publish + index. The only path that touches the brain. ──
  // Flush the draft, then promote the SERVER draft (empty body) — the client
  // never posts the doc at commit time, so a windowed doc can never truncate
  // the published table (plan §4).
  const commit = useCallback(async () => {
    if (committing) return;
    const s = JSON.stringify(docRef.current);
    if (!clipped && s === committedRef.current) return;
    setCommitting(true);
    try {
      await saveDraft();
      await apiSend(`/api/tables/${initial.id}/commit`, 'POST', {});
      committedRef.current = s;
      draftSavedRef.current = s;
      toast.success('Committed');
      // Refresh the list summary (title/updatedAt) + the selected-table query.
      void queryClient.invalidateQueries({ queryKey: ['tables'] });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast.error(e instanceof Error ? e.message : 'Commit failed');
      return;
    } finally {
      setCommitting(false);
    }
  }, [clipped, committing, initial.id, router, saveDraft, toast]);

  // ── Discard: throw away the draft, revert to the published grid. ──
  const discard = useCallback(async () => {
    try {
      await apiSend(`/api/tables/${initial.id}/discard-draft`, 'POST');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      // fire-and-forget: the re-read below reflects whatever the server kept.
    }
    try {
      const { table } = await apiFetch<{ table: TableDetail }>(`/api/tables/${initial.id}`);
      const fresh = ensureTableDoc(table.data);
      setDoc(fresh);
      committedRef.current = JSON.stringify(fresh);
      draftSavedRef.current = committedRef.current;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      // re-read failed; leave the current grid in place.
    }
    toast.success('Draft discarded');
  }, [initial.id, toast]);

  // Wire the global assistant overlay to this table: arm the Ledger specialist
  // and pin this table as context. When Ledger edits the draft (server-side), pull
  // it back into the grid and mark it saved so the autosave doesn't re-PUT it.
  // Replaces the old in-table Assist panel; the draft/Commit flow is unchanged.
  const onTableEdited = useCallback(async () => {
    try {
      const { table } = await apiFetch<{ table: TableDetail }>(`/api/tables/${initial.id}`);
      const fresh = ensureTableDoc(table.draft ?? table.data);
      setDoc(fresh);
      draftSavedRef.current = JSON.stringify(fresh);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      // re-read failed; the edit still landed server-side — a reload reconciles.
    }
  }, [initial.id]);
  const { busy: assistBusy } = useSurfaceAssist({
    surface: 'tables',
    node: { id: initial.id, kind: 'table', label: title || 'Untitled table' },
    onEdited: onTableEdited,
  });

  // ── Import a spreadsheet into the draft. ──
  const onImportFile = useCallback(
    async (file: File) => {
      setImporting(true);
      try {
        const fd = new FormData();
        fd.append('file', file);
        // FormData body: apiFetch (NOT apiSend) so the multipart boundary survives.
        const j = await apiFetch<{ rows: number; columns: number; extra_tables?: unknown[] }>(
          `/api/tables/${initial.id}/import`,
          { method: 'POST', body: fd },
        );
        // The first sheet landed in the draft — reload it.
        try {
          const { table } = await apiFetch<{ table: TableDetail }>(`/api/tables/${initial.id}`);
          setDoc(ensureTableDoc(table.draft ?? table.data));
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) return;
          // re-read failed; the import still landed server-side.
        }
        const extra = (j.extra_tables?.length ?? 0) as number;
        toast.success(
          `Imported ${j.rows} rows × ${j.columns} columns${extra ? ` (+${extra} more table${extra === 1 ? '' : 's'})` : ''}. Review, then Commit.`,
        );
        if (extra) void queryClient.invalidateQueries({ queryKey: ['tables'] });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        toast.error(e instanceof Error ? e.message : 'Import failed');
        return;
      } finally {
        setImporting(false);
      }
    },
    [initial.id, queryClient, toast],
  );

  const doDelete = useCallback(async () => {
    try {
      await apiSend(`/api/tables/${initial.id}`, 'DELETE');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast.error('Could not delete table');
      return;
    }
    toast.success('Table deleted');
    await queryClient.invalidateQueries({ queryKey: ['tables'] });
    router.push('/tables');
  }, [initial.id, queryClient, router, toast]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SetPageTitle title={title || 'Table'} />
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onImportFile(f);
          e.target.value = '';
        }}
      />
      <div className="sticky top-0 z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-border bg-background/80 px-4 py-2 backdrop-blur">
        {embedded ? (
          <div className="justify-self-start" aria-hidden />
        ) : (
          <div className="justify-self-start whitespace-nowrap">
            <BackLink href="/tables">All tables</BackLink>
          </div>
        )}
        <div className="flex items-center gap-1 justify-self-center">
          <input
            value={icon}
            onChange={(e) => setIcon(e.target.value.slice(0, 8))}
            placeholder="📊"
            className="h-8 w-9 shrink-0 rounded-md text-center text-lg outline-none transition-colors hover:bg-muted/50 focus:bg-muted/50"
            aria-label="Table icon (emoji)"
            title="Pick an emoji — on Mac press ⌃⌘Space"
          />
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-8 w-52 max-w-full border-0 bg-transparent px-1 text-center text-base font-semibold shadow-none focus-visible:ring-0"
            aria-label="Table title"
          />
        </div>
        <div className="flex items-center gap-2 justify-self-end">
          <StatusIndicator committing={committing} draftSaving={draftSaving} dirty={dirty} />
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={importing}>
            {importing ? <Loader2 className="animate-spin" /> : <Upload />} Import
          </Button>
          <ExportButton nodeId={initial.id} label="Excel" />
          {dirty && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => void discard()}>
              <Undo2 /> Discard
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => void commit()}
            disabled={(clipped ? initial.draft == null : !dirty) || committing}
          >
            <GitCommitHorizontal /> Commit
          </Button>
          <Button size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)} aria-label="Delete table">
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Lock the grid while Ledger is editing the draft so a stray edit can't
            race the specialist's server-side write (it lands in draft_data). */}
        <div
          className={
            'flex min-h-0 flex-1 flex-col overflow-hidden' +
            (assistBusy ? ' pointer-events-none opacity-60' : '')
          }
        >
          {clipped && (
            <div className="flex items-center justify-between gap-3 border-b border-border bg-accent px-3 py-1.5 text-xs text-accent-foreground">
              <span>
                Large table — showing {doc.rows.length.toLocaleString()} of {loadedTotal.toLocaleString()} rows,
                read-only in the grid. Edit rows via the assistant, or query with SQL.
              </span>
              {doc.rows.length < loadedTotal && (
                <Button size="sm" variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Load more rows
                </Button>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            <TableGrid doc={doc} onChange={clipped ? () => {} : setDoc} />
          </div>
        </div>
        {assistBusy && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm shadow-sm">
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
            <span className="font-medium text-foreground">Ledger is editing this table…</span>
          </div>
        )}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this table?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the table and its index entries. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void doDelete()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusIndicator({ committing, draftSaving, dirty }: { committing: boolean; draftSaving: boolean; dirty: boolean }) {
  if (committing) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Committing…
      </span>
    );
  }
  if (draftSaving) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…
      </span>
    );
  }
  if (dirty) return <span className="text-xs text-muted-foreground">Draft · uncommitted</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check className="size-3.5" aria-hidden /> Committed
    </span>
  );
}
