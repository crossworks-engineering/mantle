'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { TableGrid } from '@/components/table-grid/table-grid';
import { ensureTableDoc, type TableDoc } from '@mantle/content/table-model';
import type { TableDetail } from '@/lib/tables';

const DRAFT_DEBOUNCE_MS = 1200;
const META_DEBOUNCE_MS = 800;

export function TableDetailClient({ initial }: { initial: TableDetail }) {
  const router = useRouter();
  const toast = useToast();

  const published = ensureTableDoc(initial.data);
  const [doc, setDoc] = useState<TableDoc>(ensureTableDoc(initial.draft ?? initial.data));
  const [title, setTitle] = useState(initial.title);
  const [committing, setCommitting] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const docRef = useRef(doc);
  docRef.current = doc;
  const committedRef = useRef(JSON.stringify(published));
  const draftSavedRef = useRef(JSON.stringify(initial.draft ?? initial.data));
  const metaSavedRef = useRef(initial.title);
  const fileRef = useRef<HTMLInputElement>(null);

  const dirty = JSON.stringify(doc) !== committedRef.current;

  // ── Autosave the working grid to draft_data (no publish, no index). ──
  const saveDraft = useCallback(async () => {
    const s = JSON.stringify(docRef.current);
    if (s === draftSavedRef.current) return;
    setDraftSaving(true);
    try {
      const res = await fetch(`/api/tables/${initial.id}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: docRef.current }),
      });
      if (!res.ok) {
        toast.error('Could not save draft');
        return;
      }
      draftSavedRef.current = s;
    } finally {
      setDraftSaving(false);
    }
  }, [initial.id, toast]);

  // Debounced draft autosave whenever the grid changes.
  useEffect(() => {
    const s = JSON.stringify(doc);
    if (s === draftSavedRef.current) return;
    const h = setTimeout(() => void saveDraft(), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [doc, saveDraft]);

  // Title saves live (cheap metadata; never indexes).
  useEffect(() => {
    if (title === metaSavedRef.current) return;
    const h = setTimeout(async () => {
      const res = await fetch(`/api/tables/${initial.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() || 'Untitled table' }),
      });
      if (res.ok) metaSavedRef.current = title;
    }, META_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [title, initial.id]);

  // ── Commit: publish + index. The only path that touches the brain. ──
  const commit = useCallback(async () => {
    if (committing) return;
    const s = JSON.stringify(docRef.current);
    if (s === committedRef.current) return;
    setCommitting(true);
    try {
      const res = await fetch(`/api/tables/${initial.id}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: docRef.current }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? 'Commit failed');
        return;
      }
      committedRef.current = s;
      draftSavedRef.current = s;
      toast.success('Committed');
      router.refresh();
    } finally {
      setCommitting(false);
    }
  }, [committing, initial.id, router, toast]);

  // ── Discard: throw away the draft, revert to the published grid. ──
  const discard = useCallback(async () => {
    await fetch(`/api/tables/${initial.id}/discard-draft`, { method: 'POST' });
    const res = await fetch(`/api/tables/${initial.id}`);
    if (res.ok) {
      const { table } = (await res.json()) as { table: TableDetail };
      const fresh = ensureTableDoc(table.data);
      setDoc(fresh);
      committedRef.current = JSON.stringify(fresh);
      draftSavedRef.current = committedRef.current;
    }
    toast.success('Draft discarded');
  }, [initial.id, toast]);

  // ── Import a spreadsheet into the draft. ──
  const onImportFile = useCallback(
    async (file: File) => {
      setImporting(true);
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(`/api/tables/${initial.id}/import`, { method: 'POST', body: fd });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(j.error ?? 'Import failed');
          return;
        }
        // The first sheet landed in the draft — reload it.
        const got = await fetch(`/api/tables/${initial.id}`);
        if (got.ok) {
          const { table } = (await got.json()) as { table: TableDetail };
          setDoc(ensureTableDoc(table.draft ?? table.data));
        }
        const extra = (j.extra_tables?.length ?? 0) as number;
        toast.success(
          `Imported ${j.rows} rows × ${j.columns} columns${extra ? ` (+${extra} more table${extra === 1 ? '' : 's'})` : ''}. Review, then Commit.`,
        );
        if (extra) router.refresh();
      } finally {
        setImporting(false);
      }
    },
    [initial.id, router, toast],
  );

  const doDelete = useCallback(async () => {
    const res = await fetch(`/api/tables/${initial.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Could not delete table');
      return;
    }
    toast.success('Table deleted');
    router.push('/tables');
  }, [initial.id, router, toast]);

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
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-background/80 px-4 py-2 backdrop-blur">
        <div className="flex min-w-0 items-center gap-3">
          <BackLink href="/tables">All tables</BackLink>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-8 max-w-xs border-0 bg-transparent px-1 text-base font-semibold shadow-none focus-visible:ring-0"
            aria-label="Table title"
          />
        </div>
        <div className="flex items-center gap-2">
          <StatusIndicator committing={committing} draftSaving={draftSaving} dirty={dirty} />
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={importing}>
            {importing ? <Loader2 className="animate-spin" /> : <Upload />} Import
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => void discard()}>
              <Undo2 /> Discard
            </Button>
          )}
          <Button size="sm" onClick={() => void commit()} disabled={!dirty || committing}>
            <GitCommitHorizontal /> Commit
          </Button>
          <Button size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)} aria-label="Delete table">
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <TableGrid doc={doc} onChange={setDoc} />
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
