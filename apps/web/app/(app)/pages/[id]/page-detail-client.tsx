'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Editor, JSONContent } from '@tiptap/react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  GitCommitHorizontal,
  Highlighter,
  Loader2,
  MoreHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TagInput } from '@/components/tag-input';
import { BackLink } from '@/components/layout/back-link';
import { ShareControl } from '@/components/share/share-control';
import { SetPageTitle } from '@/components/layout/page-title';
import { PageEditor } from '@/components/page-editor/page-editor';
import { AiAssistPanel } from '@/components/page-editor/ai-assist-panel';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { cn } from '@/lib/utils';

type PageWidth = 'narrow' | 'wide';

type PageDetail = {
  id: string;
  title: string;
  icon: string | null;
  tags: string[];
  summary: string | null;
  visibility: 'private' | 'public';
  width: PageWidth;
  createdAt: string;
  updatedAt: string;
  doc: Record<string, unknown>;
  draft: Record<string, unknown> | null;
};

// The body autosaves into a private *draft* (cheap, never rendered or indexed).
// Only Commit publishes the draft and runs the extractor — so a long editing
// session produces one index per commit, not one per pause.
const DRAFT_DEBOUNCE_MS = 1500;
const DRAFT_MAX_WAIT_MS = 8000;
const META_DEBOUNCE_MS = 1000;

export function PageDetailClient({ initial }: { initial: PageDetail }) {
  const router = useRouter();
  const toast = useToast();

  const initialDoc = (initial.draft ?? initial.doc) as JSONContent;

  const [title, setTitle] = useState(initial.title);
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [width, setWidth] = useState<PageWidth>(initial.width);
  const [docDirty, setDocDirty] = useState(
    JSON.stringify(initial.draft ?? initial.doc) !== JSON.stringify(initial.doc),
  );
  const [draftSaving, setDraftSaving] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const docRef = useRef<JSONContent>(initialDoc);
  const editorRef = useRef<Editor | null>(null);
  const committedRef = useRef(JSON.stringify(initial.doc)); // last published doc
  const draftSavedRef = useRef(JSON.stringify(initial.draft ?? initial.doc)); // last autosaved
  const metaSavedRef = useRef(JSON.stringify({ title: initial.title, tags: initial.tags }));
  const lastDraftAtRef = useRef(Date.now());
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deletedRef = useRef(false);
  const committingRef = useRef(false);

  // ── Autosave the draft body (no publish, no index). ─────────────────
  const saveDraft = useCallback(async () => {
    if (deletedRef.current) return;
    const s = JSON.stringify(docRef.current);
    if (s === draftSavedRef.current) return;
    setDraftSaving(true);
    try {
      const res = await fetch(`/api/pages/${initial.id}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc: docRef.current }),
      });
      if (!res.ok) {
        toast.error('Could not save draft');
        return;
      }
      draftSavedRef.current = s;
      lastDraftAtRef.current = Date.now();
    } finally {
      setDraftSaving(false);
    }
  }, [initial.id, toast]);

  // ── Title / tags save live (cheap metadata, never indexes). ─────────
  const saveMeta = useCallback(async () => {
    if (deletedRef.current) return;
    const payload = { title: title.trim() || 'Untitled page', tags };
    const s = JSON.stringify(payload);
    if (s === metaSavedRef.current) return;
    const res = await fetch(`/api/pages/${initial.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) metaSavedRef.current = s;
  }, [initial.id, title, tags]);

  // ── Commit: publish + index. The only path that touches the brain. ──
  const commit = useCallback(async () => {
    if (deletedRef.current || committingRef.current) return;
    const docStr = JSON.stringify(docRef.current);
    if (docStr === committedRef.current) return; // nothing to commit
    committingRef.current = true;
    setCommitting(true);
    try {
      await saveMeta(); // make sure title/tags reflect the screen too
      const res = await fetch(`/api/pages/${initial.id}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc: docRef.current }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? 'Commit failed');
        return;
      }
      committedRef.current = docStr;
      draftSavedRef.current = docStr;
      setDocDirty(false);
      setEditedIds([]); // changes are now committed — clear the green highlight
      toast.success('Committed');
    } finally {
      committingRef.current = false;
      setCommitting(false);
    }
  }, [initial.id, saveMeta, toast]);

  // Timers fire stale closures otherwise — always reach the latest fns.
  const saveDraftRef = useRef(saveDraft);
  const saveMetaRef = useRef(saveMeta);
  const commitRef = useRef(commit);
  useEffect(() => {
    saveDraftRef.current = saveDraft;
    saveMetaRef.current = saveMeta;
    commitRef.current = commit;
  }, [saveDraft, saveMeta, commit]);

  const scheduleDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    const since = Date.now() - lastDraftAtRef.current;
    const wait = since >= DRAFT_MAX_WAIT_MS ? 0 : DRAFT_DEBOUNCE_MS;
    draftTimer.current = setTimeout(() => void saveDraftRef.current(), wait);
  }, []);

  const scheduleMeta = useCallback(() => {
    if (metaTimer.current) clearTimeout(metaTimer.current);
    metaTimer.current = setTimeout(() => void saveMetaRef.current(), META_DEBOUNCE_MS);
  }, []);

  const onDocChange = useCallback(
    (doc: JSONContent) => {
      docRef.current = doc;
      setDocDirty(JSON.stringify(doc) !== committedRef.current);
      scheduleDraft();
    },
    [scheduleDraft],
  );

  // Title / tags edits save live (skips the initial render).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    scheduleMeta();
  }, [title, tags, scheduleMeta]);

  // Leaving the editor flushes the draft + metadata — never commits.
  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (metaTimer.current) clearTimeout(metaTimer.current);
      void saveDraftRef.current();
      void saveMetaRef.current();
    };
  }, []);

  // ⌘/Ctrl+S commits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void commitRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onEditorReady = useCallback((editor: Editor) => {
    editorRef.current = editor;
  }, []);
  const onEditorBlur = useCallback(() => void saveDraftRef.current(), []);

  const onTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      editorRef.current?.commands.focus('start');
    }
  };

  const applyWidth = async (next: PageWidth) => {
    if (next === width) return;
    setWidth(next); // optimistic
    try {
      await fetch(`/api/pages/${initial.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ width: next }),
      });
    } catch {
      // Width is a cosmetic preference; a failed write just reverts next load.
    }
  };

  // AI assist panel state. Toggled on/off by the Sparkles button in the
  // toolbar.
  const [aiOpen, setAiOpen] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [aiPending, setAiPending] = useState(false);

  // ── Focus marker ────────────────────────────────────────────────────
  // `markerMode` turns the editor's left gutter into a section-marking strip;
  // `marks` is the set of block ids the user has marked for Pages to focus on.
  // Marks are an ephemeral working overlay — they never touch the document —
  // but we persist them per page in localStorage so a reload doesn't lose a
  // careful multi-section selection. They survive the editor remount on AI
  // changes (they live here, not in the editor).
  const marksKey = `mantle:page-marks:${initial.id}`;
  const [markerMode, setMarkerMode] = useState(false);
  const [marks, setMarks] = useState<string[]>([]);
  // Blocks Pages changed in the current (uncommitted) draft — highlighted green
  // so the user can spot what moved even when the text now reads differently.
  // Session-only (not persisted); cleared on commit / discard.
  const [editedIds, setEditedIds] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(marksKey);
      if (raw) setMarks(JSON.parse(raw) as string[]);
    } catch {
      // ignore malformed / unavailable storage
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      if (marks.length) localStorage.setItem(marksKey, JSON.stringify(marks));
      else localStorage.removeItem(marksKey);
    } catch {
      // ignore
    }
  }, [marks, marksKey]);

  // ── Cycle through highlights (marked blue + edited green), in doc order ──
  const highlightCursor = useRef(-1);
  const gotoHighlight = useCallback(
    (dir: 1 | -1) => {
      const editor = editorRef.current;
      if (!editor) return;
      const set = new Set([...marks, ...editedIds]);
      if (set.size === 0) return;
      // Collect matching blocks in document order (descendants is pre-order).
      const hits: { id: string; pos: number }[] = [];
      editor.state.doc.descendants((node, pos) => {
        const id = node.attrs?.id as string | undefined;
        if (typeof id === 'string' && set.has(id) && !hits.some((h) => h.id === id)) {
          hits.push({ id, pos });
        }
        return true;
      });
      if (hits.length === 0) return;
      const cur = highlightCursor.current;
      const next =
        dir === 1
          ? cur < 0
            ? 0
            : (cur + 1) % hits.length
          : cur <= 0
            ? hits.length - 1
            : cur - 1;
      highlightCursor.current = next;
      const dom = editor.view.nodeDOM(hits[next]!.pos);
      if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    [marks, editedIds],
  );
  const highlightCount = new Set([...marks, ...editedIds]).size;

  // Watch the SERVER-PROVIDED draft prop. When router.refresh() (called
  // from onAiChanged after the AI run completes) brings back a NEW draft
  // identity, this effect fires and bumps editorKey — which is what
  // remounts PageEditor with the new content. TipTap's useEditor({ content })
  // only seeds on mount, so remount is the correct primitive here. We
  // can't bump editorKey synchronously inside onAiChanged because
  // router.refresh() is async: the remount would race the prop update
  // and reseed the editor with the STALE draft (Phase 3a Pass 1 bug:
  // 'panel says it changed the page but the editor doesn't update').
  const lastDraftRef = useRef<string>(JSON.stringify(initial.draft ?? null));
  useEffect(() => {
    const current = JSON.stringify(initial.draft ?? null);
    if (current !== lastDraftRef.current) {
      lastDraftRef.current = current;
      // Also refresh our 'last committed' / 'last autosaved' refs to
      // the new state so the editor doesn't immediately think it's dirty
      // and re-autosave the freshly-arrived draft.
      committedRef.current = JSON.stringify(initial.doc);
      draftSavedRef.current = current;
      setDocDirty(JSON.stringify(initial.draft ?? initial.doc) !== JSON.stringify(initial.doc));
      setEditorKey((k) => k + 1);
    }
  }, [initial.draft, initial.doc]);

  const onAiChanged = useCallback((changedBlockIds?: string[]) => {
    // Remember which blocks now differ from the committed doc so the editor
    // can highlight them green. Empty/undefined (e.g. on discard) clears it.
    setEditedIds(changedBlockIds ?? []);
    // Pull the latest draft from the server. router.refresh re-runs the
    // server component which re-reads getPage; the new initial.draft
    // propagates down. The useEffect above detects the prop change and
    // bumps editorKey THEN — so PageEditor remounts with the right
    // content, not the stale-before-refetch content.
    router.refresh();
  }, [router]);

  const confirmDelete = async () => {
    deletedRef.current = true; // suppress flush
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
    // `h-full` (not min-h-full) is required so the side-by-side flex
    // container below can give each pane a definite height — without it,
    // the page wrapper grows past the viewport when the editor body is
    // long, and the AI-assist panel's input form ends up off-screen
    // (Phase 3a Pass 1 launch bug). The editor pane now handles its own
    // scroll via the `overflow-y-auto` wrapper directly inside the
    // side-by-side, which works equally well whether the panel is open
    // or closed.
    <div className="flex h-full min-h-0 flex-col">
      <SetPageTitle title={title || 'Untitled page'} />

      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-background/80 px-4 py-2 backdrop-blur">
        <BackLink href="/pages">All pages</BackLink>
        <div className="flex items-center gap-2">
          <StatusIndicator committing={committing} draftSaving={draftSaving} dirty={docDirty} />
          <Button size="sm" onClick={() => void commit()} disabled={!docDirty || committing}>
            <GitCommitHorizontal /> Commit
          </Button>
          <Button
            size="sm"
            variant={markerMode ? 'default' : 'outline'}
            onClick={() => setMarkerMode((v) => !v)}
            aria-pressed={markerMode}
            aria-label="Toggle focus marker"
            title="Marker — drag the left gutter to mark sections for Pages to focus on"
          >
            <Highlighter /> Mark{marks.length > 0 ? ` · ${marks.length}` : ''}
          </Button>
          {marks.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMarks([])}
              title="Clear all marked sections"
            >
              Clear
            </Button>
          )}
          {highlightCount > 0 && (
            <div className="flex items-center rounded-md border border-border">
              <Button
                variant="ghost"
                size="icon"
                className="size-9 rounded-r-none"
                onClick={() => gotoHighlight(-1)}
                aria-label="Previous highlight"
                title="Jump to previous highlight (marked + edited)"
              >
                <ChevronUp />
              </Button>
              <span className="px-1 text-xs tabular-nums text-muted-foreground" aria-hidden>
                {highlightCount}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-9 rounded-l-none"
                onClick={() => gotoHighlight(1)}
                aria-label="Next highlight"
                title="Jump to next highlight (marked + edited)"
              >
                <ChevronDown />
              </Button>
            </div>
          )}
          <Button
            size="sm"
            variant={aiOpen ? 'default' : 'outline'}
            onClick={() => setAiOpen((v) => !v)}
            aria-pressed={aiOpen}
            aria-label="Toggle AI assist panel"
            title="Ask Pages to edit this page"
          >
            <Sparkles /> AI assist
          </Button>
          <ShareControl nodeId={initial.id} beforeEnable={commit} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="Page options">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuCheckboxItem
                checked={width === 'wide'}
                onCheckedChange={(c) => void applyWidth(c ? 'wide' : 'narrow')}
              >
                Full width
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setDeleteOpen(true)}
              >
                <Trash2 /> Delete page
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Side-by-side when the AI panel is open: editor scrolls in its own
          pane, panel docks to the right. Min-h-0 on the wrapper is required
          per ui-style-guide.md so neither pane hijacks the page scroll. */}
      <div className={cn('flex min-h-0 flex-1', aiOpen ? 'flex-row' : 'flex-col')}>
        <div className={cn('min-w-0 flex-1 overflow-y-auto', aiOpen && 'border-r border-border')}>
          <div
            className={cn(
              'mx-auto w-full px-6 py-10',
              // When the AI panel is open the editor area is already narrowed
              // by the right-side panel; force narrow content so it doesn't
              // sprawl into an awkward two-thirds line length.
              aiOpen || width !== 'wide' ? 'max-w-3xl' : 'max-w-none',
            )}
          >
            {/* pl-10 mirrors the editor's drag-handle gutter (globals.css
                .ProseMirror[contenteditable]) so the title + tags line up with the
                body text. */}
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={onTitleKeyDown}
              placeholder="New page"
              aria-label="Page title"
              className="h-auto border-0 bg-transparent pl-10 pr-0 py-0 text-3xl font-bold shadow-none placeholder:text-muted-foreground/40 focus-visible:ring-0 md:text-3xl"
            />
            <div className="mt-3 pl-10">
              <TagInput value={tags} onChange={setTags} placeholder="Add tags…" />
            </div>
            <div className="mt-6">
              <PageEditor
                key={editorKey}
                content={initialDoc}
                pageId={initial.id}
                markerMode={markerMode}
                marks={marks}
                editedIds={editedIds}
                onMarksChange={setMarks}
                onChange={onDocChange}
                onBlur={onEditorBlur}
                onEditorReady={onEditorReady}
                editable={!aiPending}
              />
              {aiPending && (
                <p className="mt-3 pl-10 text-xs italic text-muted-foreground">
                  Editor locked while Pages is editing — your changes are safe.
                </p>
              )}
              {markerMode && !aiPending && (
                <p className="mt-3 pl-10 text-xs italic text-muted-foreground">
                  Marker on — drag down the left gutter to mark sections (click a marked
                  row to unmark)
                  {marks.length > 0 ? `; ${marks.length} marked` : ''}. Then open AI assist
                  and tell Pages what to do with them.
                </p>
              )}
            </div>
          </div>
        </div>
        {aiOpen && (
          // `min-h-0` here lets the inner aside's `flex-1 min-h-0`
          // scroller actually constrain — without it, the panel grows
          // with content and pushes the input form off-screen.
          <div className="hidden w-[380px] min-h-0 shrink-0 md:flex md:flex-col">
            <AiAssistPanel
              pageId={initial.id}
              focusBlockIds={marks}
              onChanged={onAiChanged}
              onClearMarks={() => setMarks([])}
              onClose={() => setAiOpen(false)}
              onPendingChange={setAiPending}
            />
          </div>
        )}
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

function StatusIndicator({
  committing,
  draftSaving,
  dirty,
}: {
  committing: boolean;
  draftSaving: boolean;
  dirty: boolean;
}) {
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
  if (dirty) {
    return <span className="text-xs text-muted-foreground">Draft · uncommitted</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check className="size-3.5" aria-hidden /> Committed
    </span>
  );
}
