'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Editor, JSONContent } from '@tiptap/react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  GitCommitHorizontal,
  GitCompareArrows,
  Highlighter,
  Loader2,
  Sparkles,
  StretchHorizontal,
  Trash2,
} from 'lucide-react';
import { computeDiffOverlay, type DiffOverlay } from '@mantle/content/page-diff';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TagInput } from '@/components/tag-input';
import { BackLink } from '@/components/layout/back-link';
import { ShareControl } from '@/components/share/share-control';
import { SetPageTitle } from '@/components/layout/page-title';
import { PageEditor } from '@/components/page-editor/page-editor';
import { PageOutline } from '@/components/page-editor/page-outline';
import { PageBacklinks } from '@/components/page-editor/page-backlinks';
import { AiAssistPanel } from '@/components/page-editor/ai-assist-panel';
import type { Backlink } from '@/lib/pages';
import { buildPageToc, type TocEntry } from '@mantle/content/page-toc';
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

export function PageDetailClient({
  initial,
  backlinks,
}: {
  initial: PageDetail;
  backlinks: Backlink[];
}) {
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
  // Nested-page count for the delete warning — parent_id is ON DELETE CASCADE,
  // so deleting this page takes its whole subtree. Fetched when the dialog opens.
  const [deleteDescendants, setDeleteDescendants] = useState<number | null>(null);
  useEffect(() => {
    if (!deleteOpen) {
      setDeleteDescendants(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/pages/${initial.id}/descendant-count`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setDeleteDescendants(typeof d.count === 'number' ? d.count : 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [deleteOpen, initial.id]);

  const docRef = useRef<JSONContent>(initialDoc);
  const editorRef = useRef<Editor | null>(null);
  const committedRef = useRef(JSON.stringify(initial.doc)); // last published doc (string)
  const committedDocRef = useRef<JSONContent>(initial.doc as JSONContent); // …as object (diff baseline)
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
      committedDocRef.current = docRef.current; // new diff baseline
      draftSavedRef.current = docStr;
      setDocDirty(false);
      setEditedIds([]); // changes are now committed — clear nav targets
      setReviewMode(false); // nothing left to review
      setDiffOverlay(null);
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

  const [tocEditor, setTocEditor] = useState<Editor | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const onEditorReady = useCallback((editor: Editor) => {
    editorRef.current = editor;
    setTocEditor(editor);
  }, []);
  const onEditorBlur = useCallback(() => void saveDraftRef.current(), []);

  // Build the outline from the live doc, rebuilt (rAF-throttled) on every edit.
  // Re-subscribes when the editor remounts after an AI change (new instance).
  useEffect(() => {
    const ed = tocEditor;
    if (!ed) return;
    let raf = 0;
    const rebuild = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setToc(buildPageToc(ed.getJSON())));
    };
    rebuild();
    ed.on('update', rebuild);
    return () => {
      cancelAnimationFrame(raf);
      ed.off('update', rebuild);
    };
  }, [tocEditor]);

  // Scroll the editor to a block by its stable id (outline click).
  const jumpToBlock = useCallback((id: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    let pos: number | null = null;
    ed.state.doc.descendants((node, p) => {
      if (pos != null) return false;
      if (node.attrs?.id === id) {
        pos = p;
        return false;
      }
      return true;
    });
    if (pos == null) return;
    const dom = ed.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

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
  // Nav targets for the ‹ › highlight cycle — the diff's added+changed block ids
  // (removed ghosts have no node to scroll to). Derived from the overlay.
  const [editedIds, setEditedIds] = useState<string[]>([]);

  // ── Visual diff / review mode (Phase 3a Pass 2) ──────────────────────────
  // `reviewMode` paints the committed-vs-draft diff in the editor (added/changed
  // borders + removed ghosts + per-block Discard/Restore). Auto-enabled after an
  // AI run; toggleable. `diffOverlay` is recomputed (rAF-throttled) from the
  // committed baseline vs the live editor doc whenever review mode is on.
  const [reviewMode, setReviewMode] = useState(false);
  const [diffOverlay, setDiffOverlay] = useState<DiffOverlay | null>(null);

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
  const reviewChangeCount = diffOverlay
    ? diffOverlay.counts.added + diffOverlay.counts.changed + diffOverlay.counts.removed
    : 0;

  // Recompute the diff overlay (committed baseline vs live doc) while review
  // mode is on — rAF-throttled, re-subscribing when the editor remounts. Off →
  // clear. editedIds (nav targets) tracks the added+changed ids.
  useEffect(() => {
    const ed = tocEditor;
    if (!ed) return;
    if (!reviewMode) {
      setDiffOverlay(null);
      setEditedIds([]);
      return;
    }
    let raf = 0;
    const recompute = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const overlay = computeDiffOverlay(
          committedDocRef.current as Record<string, unknown>,
          ed.getJSON() as Record<string, unknown>,
        );
        setDiffOverlay(overlay);
        setEditedIds([...overlay.addedIds, ...overlay.changedIds]);
      });
    };
    recompute();
    ed.on('update', recompute);
    return () => {
      cancelAnimationFrame(raf);
      ed.off('update', recompute);
    };
  }, [tocEditor, reviewMode]);

  // Per-block diff action from the editor: Discard a change (revert one block to
  // the committed baseline / delete an added block) or Restore a removed block.
  // Mutates the live doc → onChange fires → autosave + overlay recompute.
  const onDiffAction = useCallback(
    (action: 'discard' | 'restore', id: string) => {
      const ed = editorRef.current;
      if (!ed) return;
      const committedById = new Map<string, JSONContent>();
      const collect = (n: { attrs?: { id?: unknown }; content?: unknown[] } | undefined) => {
        if (!n || typeof n !== 'object') return;
        const bid = n.attrs?.id;
        if (typeof bid === 'string') committedById.set(bid, n as JSONContent);
        for (const c of (n.content as typeof n[] | undefined) ?? []) collect(c);
      };
      collect(committedDocRef.current as never);

      if (action === 'discard') {
        let target: { pos: number; size: number } | null = null;
        ed.state.doc.descendants((node, pos) => {
          if (target) return false;
          if (node.attrs?.id === id) {
            target = { pos, size: node.nodeSize };
            return false;
          }
          return true;
        });
        if (!target) return;
        const t = target as { pos: number; size: number };
        const committedJson = committedById.get(id);
        ed.chain()
          .command(({ tr }) => {
            if (committedJson) {
              // changed → revert this block to its committed version
              tr.replaceWith(t.pos, t.pos + t.size, ed.schema.nodeFromJSON(committedJson));
            } else {
              // added → drop it
              tr.delete(t.pos, t.pos + t.size);
            }
            return true;
          })
          .run();
        return;
      }

      // restore — re-insert a removed top-level block at its old spot
      const committedJson = committedById.get(id);
      if (!committedJson) return;
      const ghost = diffOverlay?.removed.find((r) => r.id === id);
      let insertPos = 0;
      if (ghost?.afterId) {
        ed.state.doc.forEach((node, offset) => {
          if (node.attrs?.id === ghost.afterId) insertPos = offset + node.nodeSize;
        });
      }
      ed.chain()
        .command(({ tr }) => {
          tr.insert(insertPos, ed.schema.nodeFromJSON(committedJson));
          return true;
        })
        .run();
    },
    [diffOverlay],
  );

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
      // The editor remounts with this content; sync docRef to it too. Without
      // this, `docRef.current` still held the pre-run doc after a Pages edit
      // (onChange only fires on user typing), so Commit saw "nothing to commit"
      // (docStr === committedRef) and silently no-oped. commitPage commits the
      // POSTED doc, so docRef MUST reflect the freshly-loaded draft.
      const next = (initial.draft ?? initial.doc) as JSONContent;
      const nextStr = JSON.stringify(next);
      docRef.current = next;
      committedRef.current = JSON.stringify(initial.doc);
      committedDocRef.current = initial.doc as JSONContent; // diff baseline
      draftSavedRef.current = nextStr;
      setDocDirty(nextStr !== committedRef.current);
      setEditorKey((k) => k + 1);
    }
  }, [initial.draft, initial.doc]);

  const onAiChanged = useCallback((changedBlockIds?: string[]) => {
    // An AI run (array arg, even empty) enters review mode so the user sees the
    // diff; a discard (no arg) leaves it. The overlay itself is recomputed from
    // committed-vs-draft after the remount — no need to thread block ids here.
    setReviewMode(changedBlockIds !== undefined);
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
          {docDirty && (
            <Button
              size="sm"
              variant={reviewMode ? 'default' : 'outline'}
              onClick={() => setReviewMode((v) => !v)}
              aria-pressed={reviewMode}
              title="Review changes — show what Commit will publish vs the live page"
            >
              <GitCompareArrows /> Review{reviewChangeCount > 0 ? ` · ${reviewChangeCount}` : ''}
            </Button>
          )}
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
          <Button
            size="sm"
            variant={width === 'wide' ? 'default' : 'outline'}
            onClick={() => void applyWidth(width === 'wide' ? 'narrow' : 'wide')}
            aria-pressed={width === 'wide'}
            title="Toggle full width"
          >
            <StretchHorizontal /> Full width
          </Button>
          <ShareControl nodeId={initial.id} beforeEnable={commit} />
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
            title="Delete page"
          >
            <Trash2 /> Delete
          </Button>
        </div>
      </div>

      {/* Side-by-side when the AI panel is open: editor scrolls in its own
          pane, panel docks to the right. Min-h-0 on the wrapper is required
          per ui-style-guide.md so neither pane hijacks the page scroll. */}
      <div className={cn('flex min-h-0 flex-1', aiOpen ? 'flex-row' : 'flex-col')}>
        <div className={cn('min-w-0 flex-1 overflow-y-auto', aiOpen && 'border-r border-border')}>
          {/* Header band — page chrome (name + tags). A themed strip with a
              bottom border so the title reads as a label ABOUT the page, not as
              the document's first line. Full-width bg; content stays centred. */}
          <header className="border-b border-border bg-muted/40">
            <div
              className={cn(
                'mx-auto w-full px-6 py-3',
                aiOpen || width !== 'wide' ? 'max-w-3xl' : 'max-w-none',
              )}
            >
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={onTitleKeyDown}
                placeholder="New page"
                aria-label="Page title"
                // No box — only a bottom underline that appears (primary) while
                // editing. A 2px transparent bottom border is always reserved so
                // focusing doesn't shift the layout.
                className="h-auto rounded-none border-x-0 border-t-0 border-b-2 border-transparent bg-transparent px-0 py-0.5 text-center text-2xl font-bold shadow-none transition-colors placeholder:text-muted-foreground/40 focus-visible:border-primary focus-visible:ring-0 md:text-2xl"
              />
              <div className="mt-2">
                <TagInput value={tags} onChange={setTags} placeholder="Add tags…" />
              </div>
            </div>
          </header>

          {/* Document body — outline rail (left, wide screens) + centred content.
              The rail is hidden while the AI panel is open (no room). */}
          <div className="flex w-full gap-6 px-6 py-8">
            {!aiOpen && toc.length > 0 && (
              <aside className="hidden w-56 shrink-0 xl:block">
                <div className="sticky top-6 max-h-[calc(100vh-9rem)] overflow-y-auto scrollbar-thin">
                  <PageOutline entries={toc} onJump={jumpToBlock} />
                </div>
              </aside>
            )}
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  'mx-auto w-full',
                  // When the AI panel is open the editor area is already narrowed
                  // by the right-side panel; force narrow content so it doesn't
                  // sprawl into an awkward two-thirds line length.
                  aiOpen || width !== 'wide' ? 'max-w-3xl' : 'max-w-none',
                )}
              >
                <PageEditor
                  key={editorKey}
                  content={initialDoc}
                  pageId={initial.id}
                  markerMode={markerMode}
                  marks={marks}
                  diff={reviewMode ? diffOverlay : null}
                  onDiffAction={onDiffAction}
                  onMarksChange={setMarks}
                  onChange={onDocChange}
                  onBlur={onEditorBlur}
                  onEditorReady={onEditorReady}
                  editable={!aiPending}
                />
                {aiPending && (
                  <div className="mt-3 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm shadow-sm">
                    <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
                    <span className="font-medium text-foreground">Pages is editing your page…</span>
                    <span className="text-muted-foreground">— your changes are safe</span>
                  </div>
                )}
                {markerMode && !aiPending && (
                  <p className="mt-3 pl-10 text-xs italic text-muted-foreground">
                    Marker on — drag down the left gutter to mark sections (click a marked
                    row to unmark)
                    {marks.length > 0 ? `; ${marks.length} marked` : ''}. Then open AI assist
                    and tell Pages what to do with them.
                  </p>
                )}
                <PageBacklinks backlinks={backlinks} />
              </div>
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
            <AlertDialogDescription>
              {deleteDescendants && deleteDescendants > 0
                ? `This also permanently deletes ${deleteDescendants} nested page${deleteDescendants === 1 ? '' : 's'}. This can’t be undone.`
                : 'This can’t be undone.'}
            </AlertDialogDescription>
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
