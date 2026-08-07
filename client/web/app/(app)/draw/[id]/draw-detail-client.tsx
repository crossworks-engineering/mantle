'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, GitCommitHorizontal, Loader2, Trash2, Undo2 } from 'lucide-react';
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { Button } from '@mantle/web-ui/ui/button';
import { Input } from '@mantle/web-ui/ui/input';
import { TagInput } from '@/components/tag-input';
import { BackLink } from '@mantle/web-ui/layout/back-link';
import { SetPageTitle } from '@/components/layout/page-title';
import { ExcalidrawCanvas, type SceneChange } from '@/components/draw/excalidraw-canvas';
import { loadSceneFiles, uploadNewSceneFiles } from '@/components/draw/scene-files';
import { apiFetch, apiSend, ApiError } from '@mantle/web-ui/api-fetch';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@mantle/web-ui/ui/alert-dialog';
import { useToast } from '@mantle/web-ui/ui/toast';

type DrawDetail = {
  id: string;
  title: string;
  tags: string[];
  summary: string | null;
  visibility: 'private' | 'public';
  createdAt: string;
  updatedAt: string;
  scene: Record<string, unknown>;
  draft: Record<string, unknown> | null;
  draftRev?: number;
  fileRefs: Record<string, string>;
};

// Same cadence as pages: the canvas autosaves into a private draft (cheap,
// never rendered or indexed); only Commit publishes and runs the extractor.
// The canvas fires onChange on every stroke, so the debounce is what keeps a
// sketching session from being hundreds of PUTs.
const DRAFT_DEBOUNCE_MS = 1500;
const DRAFT_MAX_WAIT_MS = 8000;
const META_DEBOUNCE_MS = 1000;

/** The excalidraw module namespace, loaded lazily — the package touches
 *  window at module scope, so it must never load during SSR. */
type ExcalidrawModule = typeof import('@excalidraw/excalidraw');

/** The durable appState subset we persist (mirror of the server whitelist in
 *  normalizeScene — send only what will be stored). */
function pickAppState(appState: AppState): Record<string, unknown> {
  return {
    viewBackgroundColor: appState.viewBackgroundColor,
    ...(appState.gridSize !== undefined ? { gridSize: appState.gridSize } : {}),
    ...(appState.gridModeEnabled !== undefined
      ? { gridModeEnabled: appState.gridModeEnabled }
      : {}),
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    zoom: appState.zoom,
  };
}

/**
 * Outer gate: client-fetch the draw, then mount the editor with loaded data
 * (it seeds refs from `initial`, so it must only mount once data exists).
 * refetchOnMount 'always' + the isFetchedAfterMount gate mirror pages: the
 * editor seeds its draft etag from this response, and a cached rev would 409
 * on the first autosave and wipe the strokes.
 */
export function DrawDetailClient({ drawId }: { drawId: string }) {
  const drawQuery = useQuery({
    queryKey: ['draws', drawId],
    queryFn: () => apiFetch<{ draw: DrawDetail }>(`/api/draws/${drawId}`).then((r) => r.draw),
    refetchOnMount: 'always',
  });

  if (drawQuery.isPending || (!drawQuery.isFetchedAfterMount && !drawQuery.isError)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (drawQuery.isError) {
    const notFound =
      drawQuery.error instanceof Error && /not found|404/i.test(drawQuery.error.message);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-muted-foreground">
          {notFound ? 'Drawing not found.' : 'Failed to load drawing.'}
        </p>
        <BackLink href="/draw">Back to drawings</BackLink>
      </div>
    );
  }

  return <DrawEditor initial={drawQuery.data} />;
}

function DrawEditor({ initial }: { initial: DrawDetail }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [title, setTitle] = useState(initial.title);
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [dirty, setDirty] = useState(initial.draft !== null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reverting, setReverting] = useState(false);

  // The canvas mounts only after the module + scene files resolve; remounting
  // with a bumped key is how foreign draft changes (another device, later an
  // agent) are adopted — initialData only seeds on mount.
  const [canvasKey, setCanvasKey] = useState(0);
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);

  const modRef = useRef<ExcalidrawModule | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  // Latest scene from onChange — what saves serialize. Seeded on load.
  const sceneRef = useRef<{
    elements: readonly OrderedExcalidrawElement[];
    appState: AppState | null;
    files: BinaryFiles;
  }>({ elements: [], appState: null, files: {} });
  const fileRefsRef = useRef<Record<string, string>>(initial.fileRefs);
  const draftRevRef = useRef(initial.draftRev ?? 0);
  const committedHashRef = useRef<number>(0); // hash of the published elements
  const savedHashRef = useRef<number>(0); // hash last autosaved (or published)
  const metaSavedRef = useRef(JSON.stringify({ title: initial.title, tags: initial.tags }));
  const lastDraftAtRef = useRef(Date.now());
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deletedRef = useRef(false);
  const committingRef = useRef(false);
  const conflictRef = useRef(false); // pause autosave after a 409 until remount
  const saveInFlightRef = useRef(false);
  const saveQueuedRef = useRef(false);

  // ── Load: restore() the working scene (draft ?? committed) + its files. ──
  // restore() is upstream's scene-format migration — every stored scene passes
  // through it on read, so package upgrades never hand the canvas stale JSON.
  const loadScene = useCallback(async (detail: DrawDetail) => {
    const mod = modRef.current ?? (await import('@excalidraw/excalidraw'));
    modRef.current = mod;
    const working = (detail.draft ?? detail.scene) as {
      elements?: OrderedExcalidrawElement[];
      appState?: Record<string, unknown>;
    };
    const committed = (detail.scene ?? {}) as { elements?: OrderedExcalidrawElement[] };
    const fileList = await loadSceneFiles(detail.fileRefs);
    const files: BinaryFiles = {};
    for (const f of fileList) files[f.id] = f;
    const restored = mod.restore(
      { elements: working.elements ?? [], appState: working.appState ?? {}, files },
      null,
      null,
    );
    sceneRef.current = {
      elements: restored.elements as readonly OrderedExcalidrawElement[],
      appState: null, // adopted from the first onChange
      files,
    };
    committedHashRef.current = mod.hashElementsVersion(
      (committed.elements ?? []) as OrderedExcalidrawElement[],
    );
    savedHashRef.current = mod.hashElementsVersion(restored.elements);
    setDirty(detail.draft !== null);
    setInitialData({
      elements: restored.elements,
      appState: restored.appState,
      files,
      // Saved scroll/zoom (if any) round-trips via appState; scrollToContent
      // only when nothing was saved, so a fresh open centres the drawing.
      scrollToContent: working.appState?.scrollX === undefined,
    });
  }, []);

  useEffect(() => {
    void loadScene(initial);
    // Mount-only: the draft watcher below handles subsequent server changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Autosave the draft scene (no publish, no index). ──────────────────
  const saveDraft = useCallback(async () => {
    if (deletedRef.current) return;
    if (conflictRef.current) return;
    if (saveInFlightRef.current || committingRef.current) {
      saveQueuedRef.current = true;
      return;
    }
    const mod = modRef.current;
    if (!mod) return;
    // ONE snapshot for the whole save; drawing can continue during the await.
    const snapshot = sceneRef.current;
    const hash = mod.hashElementsVersion(snapshot.elements);
    if (hash === savedHashRef.current) return;
    saveInFlightRef.current = true;
    setDraftSaving(true);
    try {
      // New scene images ride the files pipeline before the scene references
      // them — the scene blob itself never carries bytes.
      const refs = await uploadNewSceneFiles(snapshot.files, fileRefsRef.current);
      const refsChanged = refs !== fileRefsRef.current;
      fileRefsRef.current = refs;
      let saved: { draft_rev?: number };
      try {
        saved = await apiSend<{ draft_rev: number }>(`/api/draws/${initial.id}/draft`, 'PUT', {
          scene: {
            elements: snapshot.elements,
            ...(snapshot.appState ? { appState: pickAppState(snapshot.appState) } : {}),
          },
          ...(refsChanged ? { file_refs: refs } : {}),
          if_rev: draftRevRef.current,
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        if (e instanceof ApiError && e.status === 409) {
          // Another writer advanced the draft. Pause autosaving until the
          // refetch remounts the canvas on server truth (draft watcher).
          conflictRef.current = true;
          savedHashRef.current = hash;
          toast.error('This drawing changed elsewhere. Reloading the latest draft');
          void queryClient.invalidateQueries({ queryKey: ['draws', initial.id] });
          return;
        }
        toast.error(e instanceof Error ? e.message : 'Could not save draft');
        return;
      }
      if (typeof saved.draft_rev === 'number') draftRevRef.current = saved.draft_rev;
      savedHashRef.current = hash;
      lastDraftAtRef.current = Date.now();
    } finally {
      saveInFlightRef.current = false;
      setDraftSaving(false);
      if (saveQueuedRef.current) {
        saveQueuedRef.current = false;
        void saveDraftRef.current();
      }
    }
  }, [initial.id, queryClient, toast]);

  // ── Title / tags save live (cheap metadata, never indexes). ───────────
  const saveMeta = useCallback(async () => {
    if (deletedRef.current) return;
    const payload = { title: title.trim() || 'Untitled drawing', tags };
    const s = JSON.stringify(payload);
    if (s === metaSavedRef.current) return;
    try {
      await apiSend(`/api/draws/${initial.id}`, 'PATCH', payload);
      metaSavedRef.current = s;
    } catch {
      // Silent — reverts on next load; apiSend's 401 bounce still fires.
    }
  }, [initial.id, title, tags]);

  // ── Commit: publish + index + capture the SVG snapshot. ───────────────
  const commit = useCallback(async () => {
    if (deletedRef.current || committingRef.current) return;
    const mod = modRef.current;
    if (!mod) return;
    if (mod.hashElementsVersion(sceneRef.current.elements) === committedHashRef.current) return;
    committingRef.current = true;
    setCommitting(true);
    try {
      await saveMeta();
      // Wait out an in-flight autosave — it holds the same if_rev.
      while (saveInFlightRef.current) await new Promise((r) => setTimeout(r, 50));
      const snapshot = sceneRef.current;
      const hash = mod.hashElementsVersion(snapshot.elements);
      const refs = await uploadNewSceneFiles(snapshot.files, fileRefsRef.current);
      fileRefsRef.current = refs;
      // The published scene drops deleted elements (they exist only for
      // in-session undo); the draft keeps them.
      const live = snapshot.elements.filter((el) => !el.isDeleted);
      // The snapshot every non-editor surface renders. Best-effort: a failed
      // export commits without a preview rather than blocking the publish.
      let svg: string | undefined;
      try {
        const svgEl = await mod.exportToSvg({
          elements: live,
          appState: {
            exportBackground: true,
            exportWithDarkMode: false,
            exportEmbedScene: false,
            ...(snapshot.appState
              ? { viewBackgroundColor: snapshot.appState.viewBackgroundColor }
              : {}),
          },
          files: snapshot.files,
        });
        svg = svgEl.outerHTML;
      } catch {
        svg = undefined;
      }
      try {
        const { draw } = await apiSend<{ draw: { draftRev?: number } }>(
          `/api/draws/${initial.id}/commit`,
          'POST',
          {
            scene: {
              elements: live,
              ...(snapshot.appState ? { appState: pickAppState(snapshot.appState) } : {}),
            },
            ...(svg ? { svg } : {}),
            file_refs: refs,
            if_rev: draftRevRef.current,
          },
        );
        if (typeof draw?.draftRev === 'number') draftRevRef.current = draw.draftRev;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        if (e instanceof ApiError && e.status === 409) {
          toast.error('This drawing changed elsewhere. Reloading the latest draft');
          void queryClient.invalidateQueries({ queryKey: ['draws', initial.id] });
          return;
        }
        toast.error(e instanceof Error ? e.message : 'Commit failed');
        return;
      }
      committedHashRef.current = hash;
      savedHashRef.current = hash;
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['draws'], exact: false });
      toast.success('Committed');
    } finally {
      committingRef.current = false;
      setCommitting(false);
      if (saveQueuedRef.current) {
        saveQueuedRef.current = false;
        void saveDraftRef.current();
      }
    }
  }, [initial.id, queryClient, saveMeta, toast]);

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

  // Every canvas change lands here — including pure selection/viewport moves,
  // which don't bump element versions and are filtered by the hash compare.
  const onSceneChange = useCallback(
    (change: SceneChange) => {
      sceneRef.current = {
        elements: change.elements,
        appState: change.appState,
        files: change.files,
      };
      const mod = modRef.current;
      if (!mod) return;
      const hash = mod.hashElementsVersion(change.elements);
      setDirty(hash !== committedHashRef.current);
      if (hash !== savedHashRef.current) scheduleDraft();
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

  // Leaving the editor flushes the draft + metadata — never commits. The
  // pagehide flush covers hard reloads/closes (best-effort; the debounce
  // window is the only exposure and the draft PUT is cheap).
  useEffect(() => {
    const flush = () => {
      void saveDraftRef.current();
      void saveMetaRef.current();
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (metaTimer.current) clearTimeout(metaTimer.current);
      flush();
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

  // Watch the server-provided draft rev: rev-ahead ⇔ a foreign writer (second
  // device, later an agent) advanced the draft — adopt it by reloading the
  // scene and remounting the canvas. Echoes of our own writes are ≤ and
  // ignored (same reasoning as pages).
  useEffect(() => {
    const rev = initial.draftRev ?? 0;
    if (rev > draftRevRef.current) {
      draftRevRef.current = rev;
      fileRefsRef.current = initial.fileRefs;
      conflictRef.current = false;
      void loadScene(initial).then(() => setCanvasKey((k) => k + 1));
    }
  }, [initial, loadScene]);

  // Revert the whole draft to the last commit.
  const revertDraft = useCallback(async () => {
    if (reverting) return;
    setReverting(true);
    try {
      await apiSend(`/api/draws/${initial.id}/discard-draft`, 'POST');
      toast.success('Draft reverted to last commit');
      // Refetch → rev-ahead → loadScene + remount via the draft watcher.
      void queryClient.invalidateQueries({ queryKey: ['draws', initial.id] });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast.error(e instanceof Error ? e.message : 'Could not revert draft');
    } finally {
      setReverting(false);
    }
  }, [reverting, initial.id, queryClient, toast]);

  const confirmDelete = async () => {
    deletedRef.current = true; // suppress the unmount flush
    try {
      await apiSend(`/api/draws/${initial.id}`, 'DELETE');
    } catch (e) {
      deletedRef.current = false;
      if (e instanceof ApiError && e.status === 401) return;
      toast.error(e instanceof Error ? e.message : 'Could not delete drawing');
      return;
    }
    toast.success('Drawing deleted');
    void queryClient.invalidateQueries({ queryKey: ['draws'] });
    router.push('/draw');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SetPageTitle title={title || 'Untitled drawing'} />

      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 gap-y-1.5 border-b border-border bg-background/80 px-4 py-2 backdrop-blur">
        <BackLink href="/draw">All drawings</BackLink>
        <div className="flex flex-wrap items-center gap-2 gap-y-1.5">
          <StatusIndicator committing={committing} draftSaving={draftSaving} dirty={dirty} />
          <Button size="sm" onClick={() => void commit()} disabled={!dirty || committing}>
            <GitCommitHorizontal /> Commit
          </Button>
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive-ink"
              onClick={() => void revertDraft()}
              disabled={reverting}
              title="Revert the drawing to the last commit"
            >
              <Undo2 /> {reverting ? 'Reverting…' : 'Revert'}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive-ink"
            onClick={() => setDeleteOpen(true)}
            aria-label="Delete drawing"
            title="Delete this drawing"
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <header className="border-b border-border bg-muted/40">
        <div className="w-full px-6 py-3">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New drawing"
            aria-label="Drawing title"
            className="h-auto min-w-0 flex-1 rounded-none border-x-0 border-t-0 border-b-2 border-transparent bg-transparent px-0 py-0.5 text-2xl font-bold shadow-none transition-colors placeholder:text-muted-foreground/40 focus-visible:border-primary focus-visible:ring-0 md:text-2xl"
          />
          <div className="mt-2">
            <TagInput value={tags} onChange={setTags} placeholder="Add tags…" />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {initialData ? (
          <ExcalidrawCanvas
            key={canvasKey}
            initialData={initialData}
            onChange={onSceneChange}
            onApiReady={(api) => {
              apiRef.current = api;
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this drawing?</AlertDialogTitle>
            <AlertDialogDescription>
              “{title || 'Untitled drawing'}” and its brain index will be removed. Images embedded
              from the files area are kept there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void confirmDelete()}
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
