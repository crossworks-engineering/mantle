'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { JSONContent } from '@tiptap/react';
import { Check, Loader2, Save, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TagInput } from '@/components/tag-input';
import { BackLink } from '@/components/layout/back-link';
import { SetPageTitle } from '@/components/layout/page-title';
import { PageEditor } from '@/components/page-editor/page-editor';
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
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format-datetime';

type PageDetail = {
  id: string;
  title: string;
  icon: string | null;
  tags: string[];
  summary: string | null;
  visibility: 'private' | 'public';
  createdAt: string;
  updatedAt: string;
  doc: Record<string, unknown>;
};

type SaveState = 'saved' | 'saving' | 'dirty';

// Persistence is cheap (one UPDATE) so it runs often, for durability.
// Indexing is expensive (extractor: LLM summary + embedding + facts) so it
// runs only when editing has clearly settled. These two cadences are the
// whole point — frequent saves, rare re-indexing.
const PERSIST_DEBOUNCE_MS = 1500; // quiet period before a cheap save
const PERSIST_MAX_WAIT_MS = 8000; // …but never let unsaved text get older than this
const INDEX_IDLE_MS = 12000; // stop typing this long → re-index once

export function PageDetailClient({ initial }: { initial: PageDetail }) {
  const router = useRouter();
  const toast = useToast();

  const [title, setTitle] = useState(initial.title);
  const [tags, setTags] = useState<string[]>(initial.tags);
  const docRef = useRef<JSONContent>(initial.doc as JSONContent);

  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [updatedAt, setUpdatedAt] = useState(initial.updatedAt);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // `persistedRef` = what's in the DB; `indexedRef` = what the extractor last
  // saw (doc only — title/tags don't affect a page's index). The initial doc
  // arrives already indexed.
  const persistedRef = useRef(
    JSON.stringify({ title: initial.title, tags: initial.tags, doc: initial.doc }),
  );
  const indexedRef = useRef(JSON.stringify(initial.doc));
  const lastPersistAtRef = useRef(Date.now());
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const indexTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deletedRef = useRef(false);

  // ── Cheap save: persist the document, do NOT re-index. ──────────────
  const persist = useCallback(async () => {
    if (deletedRef.current) return;
    const payload = { title: title.trim() || 'Untitled page', tags, doc: docRef.current };
    const serialized = JSON.stringify(payload);
    if (serialized === persistedRef.current) {
      setSaveState('saved');
      return;
    }
    setSaveState('saving');
    const res = await fetch(`/api/pages/${initial.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, reindex: false }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? 'Save failed');
      setSaveState('dirty');
      return;
    }
    const { page } = (await res.json()) as { page: PageDetail };
    persistedRef.current = serialized;
    lastPersistAtRef.current = Date.now();
    setUpdatedAt(page.updatedAt);
    setSaveState('saved');
  }, [title, tags, initial.id, toast]);

  // ── Expensive commit: ensure persisted, then re-index once. ─────────
  const commit = useCallback(async () => {
    if (deletedRef.current) return;
    await persist();
    const docStr = JSON.stringify(docRef.current);
    if (docStr === indexedRef.current) return; // nothing new to index
    const res = await fetch(`/api/pages/${initial.id}/reindex`, { method: 'POST' });
    if (res.ok) indexedRef.current = docStr;
  }, [persist, initial.id]);

  // Timers fire stale closures otherwise — always reach the latest fns.
  const persistRef = useRef(persist);
  const commitRef = useRef(commit);
  useEffect(() => {
    persistRef.current = persist;
    commitRef.current = commit;
  }, [persist, commit]);

  const scheduleSave = useCallback(() => {
    setSaveState('dirty');
    // Persist: debounce, but force it through if text has been unsaved too long.
    if (persistTimer.current) clearTimeout(persistTimer.current);
    const sincePersist = Date.now() - lastPersistAtRef.current;
    const wait = sincePersist >= PERSIST_MAX_WAIT_MS ? 0 : PERSIST_DEBOUNCE_MS;
    persistTimer.current = setTimeout(() => void persistRef.current(), wait);
    // Re-index: only after a long idle (every edit pushes it further out).
    if (indexTimer.current) clearTimeout(indexTimer.current);
    indexTimer.current = setTimeout(() => void commitRef.current(), INDEX_IDLE_MS);
  }, []);

  // Title / tags edits schedule a save (skips the initial render).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    scheduleSave();
  }, [title, tags, scheduleSave]);

  // Leaving the editor: flush + index whatever's pending.
  useEffect(() => {
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
      if (indexTimer.current) clearTimeout(indexTimer.current);
      void commitRef.current();
    };
  }, []);

  const onDocChange = useCallback(
    (doc: JSONContent) => {
      docRef.current = doc;
      scheduleSave();
    },
    [scheduleSave],
  );

  // Blur of the editor body is a natural "I paused" signal → index now.
  const onEditorBlur = useCallback(() => void commitRef.current(), []);

  const saveNow = async () => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    if (indexTimer.current) clearTimeout(indexTimer.current);
    await commitRef.current();
  };

  const confirmDelete = async () => {
    deletedRef.current = true; // suppress the unmount flush
    const res = await fetch(`/api/pages/${initial.id}`, { method: 'DELETE' });
    if (!res.ok) {
      deletedRef.current = false;
      toast.error('Could not delete page');
      return;
    }
    toast.success('Page deleted');
    router.push('/pages');
  };

  return (
    <div className="space-y-4">
      <SetPageTitle title={title || 'Untitled page'} />
      <div className="flex items-center justify-between gap-3">
        <BackLink href="/pages">All pages</BackLink>
        <SaveIndicator state={saveState} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled page"
          className="text-lg font-semibold"
        />
      </div>

      <PageEditor
        content={initial.doc as JSONContent}
        onChange={onDocChange}
        onBlur={onEditorBlur}
      />

      <div className="space-y-1.5">
        <Label htmlFor="tags">Tags</Label>
        <TagInput
          id="tags"
          value={tags}
          onChange={setTags}
          placeholder="Type and press comma or Enter…"
        />
      </div>

      {initial.summary && (
        <aside className="rounded-md border border-border bg-muted/40 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Sparkles className="size-3.5" aria-hidden /> Indexed summary
          </div>
          <p className="text-sm text-muted-foreground">{initial.summary}</p>
        </aside>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">
          Updated {formatDateTime(updatedAt)} · created {formatDateTime(initial.createdAt)}
        </span>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
            aria-label="Delete page"
          >
            <Trash2 />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={saveNow}
            disabled={saveState === 'saving'}
          >
            <Save /> {saveState === 'saving' ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{title || 'Untitled page'}”?</AlertDialogTitle>
            <AlertDialogDescription>This can’t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'saving') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…
      </span>
    );
  }
  if (state === 'dirty') {
    return <span className="text-xs text-muted-foreground">Unsaved changes</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check className="size-3.5" aria-hidden /> Saved
    </span>
  );
}
