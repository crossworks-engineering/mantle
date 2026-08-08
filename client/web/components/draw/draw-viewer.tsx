'use client';

import { useEffect, useState } from 'react';
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { ExcalidrawCanvas } from '@/components/draw/excalidraw-canvas';
import { loadSceneFiles } from '@/components/draw/scene-files';

/**
 * A drawing you can move around in without being able to change it.
 *
 * The list preview shows the committed SNAPSHOT — one flat image, which is the
 * right default (it is instant, it is what every other surface shows, and
 * browsing a list must not pay for the editor bundle). But a snapshot cannot be
 * panned or zoomed, so a diagram bigger than the pane was unreadable without
 * opening it for editing, which is a strange thing to have to do to LOOK at
 * something.
 *
 * Upstream's `viewModeEnabled` is exactly the missing piece: the real canvas,
 * with pan and zoom and no editing UI. It is mounted only when asked for, so
 * the cheap-list decision survives — the cost lands on the click, not on every
 * row you select.
 *
 * The COMMITTED scene only, never the draft. This is a viewer, and it should
 * agree with the snapshot beside it rather than reveal work in progress — the
 * same rule every non-editor surface follows.
 */
export function DrawViewer({ drawId }: { drawId: string }) {
  const [data, setData] = useState<ExcalidrawInitialDataState | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // restore() is upstream's scene-format migration — the same call the
        // editor makes on load, so an old scene renders as the current version
        // understands it rather than being quietly misdrawn.
        const [{ draw }, mod] = await Promise.all([
          apiFetch<{
            draw: {
              scene?: { elements?: unknown[]; appState?: Record<string, unknown> } | null;
              fileRefs?: Record<string, string> | null;
            };
          }>(`/api/draws/${encodeURIComponent(drawId)}`),
          import('@excalidraw/excalidraw'),
        ]);
        if (cancelled) return;
        const scene = draw.scene ?? {};
        // Scene images live in the files pipeline, never in the scene blob; the
        // editor's own loader rehydrates them, so reuse it rather than drawing
        // empty frames where the screenshots are.
        const fileList = await loadSceneFiles(draw.fileRefs ?? {});
        if (cancelled) return;
        const files: BinaryFiles = {};
        for (const f of fileList) files[f.id] = f;
        const restored = mod.restore(
          {
            elements: (scene.elements ?? []) as OrderedExcalidrawElement[],
            appState: scene.appState ?? {},
            files,
          },
          null,
          null,
        );
        setData({
          elements: restored.elements,
          appState: restored.appState,
          files,
          // Always centre: the viewer opens on the drawing, not on wherever the
          // author last left the scroll.
          scrollToContent: true,
        });
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [drawId]);

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm italic text-muted-foreground">
        Couldn’t load this drawing.
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return <ExcalidrawCanvas initialData={data} viewMode />;
}
