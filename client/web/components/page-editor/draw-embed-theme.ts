'use client';

import { useEffect } from 'react';
import type { Editor } from '@tiptap/react';
import { assetUrl } from '@mantle/web-ui/asset-url';
import { snapshotPlacesImage } from '@/components/draw/snapshot-theme';

/**
 * Marks the drawings a page embeds as safe to theme-invert under dark mode.
 *
 * The embed is a plain `<img>` produced by a static `renderHTML` (image.ts):
 * no theme, no React node view, no data. `DRAW_EMBED_CLASS` arms the CSS rule
 * on every embed and this stamps `data-draw-theme="invert"` on the ones that
 * qualify, so the rule only fires for a snapshot that carries no pasted raster
 * image (see `snapshotPlacesImage` for why those are excluded).
 *
 * The default is un-inverted, which is exactly today's rendering — so a slow
 * or failed check leaves the page as it was rather than flashing through a
 * wrong state.
 *
 * The check reads the snapshot the `<img>` is already loading, at the same URL,
 * so the browser serves it from cache rather than fetching it twice. Answers
 * are memoised for the session: an embed appearing on ten pages costs one look.
 */

/** drawId → "may this be inverted". Module-level so it survives remounts and
 *  is shared by the editor and the read-only view. */
const cache = new Map<string, Promise<boolean>>();

function mayInvert(drawId: string): Promise<boolean> {
  const hit = cache.get(drawId);
  if (hit) return hit;
  // The SAME url the <img> uses (assetUrl adds the `?at=` token a detached
  // client needs), so this is a cache hit rather than a second download.
  const url = assetUrl(`/api/draws/${encodeURIComponent(drawId)}/svg?raw=1`);
  const p = fetch(url)
    .then((res) => (res.ok ? res.text() : null))
    .then((svg) => svg !== null && !snapshotPlacesImage(svg))
    // A drawing that can't be read stays light: the failure must not be
    // louder than the thing it was trying to improve.
    .catch(() => false);
  cache.set(drawId, p);
  return p;
}

export function useDrawEmbedTheme(editor: Editor | null): void {
  useEffect(() => {
    if (!editor) return;
    let live = true;

    const stamp = () => {
      const imgs = editor.view.dom.querySelectorAll<HTMLImageElement>(
        'img[data-draw-id]:not([data-draw-theme])',
      );
      for (const img of imgs) {
        const id = img.getAttribute('data-draw-id');
        if (!id) continue;
        void mayInvert(id).then((ok) => {
          // Re-read the element's own id: ProseMirror recycles DOM across
          // edits, so the node under this reference may have moved on.
          if (live && ok && img.getAttribute('data-draw-id') === id) {
            img.setAttribute('data-draw-theme', 'invert');
          }
        });
      }
    };

    stamp();
    // Every re-render can bring new embeds (the picker inserts one mid-session)
    // and can rebuild existing ones, which drops the attribute — so re-stamp on
    // update, not just on mount. Cheap: the selector skips anything stamped and
    // the lookups are memoised.
    editor.on('update', stamp);
    return () => {
      live = false;
      editor.off('update', stamp);
    };
  }, [editor]);
}
