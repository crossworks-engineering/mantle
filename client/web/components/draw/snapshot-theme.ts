/**
 * How an in-app surface renders a committed snapshot under the dark theme.
 *
 * Excalidraw's dark mode is a CSS FILTER over the canvas, not a change to
 * element colours: a drawing made in dark mode stores `#1e1e1e` strokes on a
 * `#ffffff` canvas and you are shown the inverse. The snapshot is captured with
 * `exportWithDarkMode: false` on purpose (docs/draw.md §5a) — it is served to
 * share links, PDF, Word and a sidecar re-render that is always light, so it
 * must not depend on which theme its author happened to have open.
 *
 * That left the editor inverting and every other surface not, which reads as
 * "my drawing came back in the wrong theme". So the app surfaces apply the same
 * filter the canvas does, at view time. Nothing stored or exported changes.
 *
 * Not applied to the share surface, `/print`, or either export: those leave the
 * brain, where there is no app theme to follow.
 */

// Both classes carry Excalidraw's own THEME_FILTER — copied deliberately
// rather than imported, since it is a private constant in the package and the
// point is that our surfaces match the canvas. Re-check on a pin bump,
// alongside draw-theme.css.
//
// WRITTEN OUT IN FULL, and they must stay that way. Tailwind v4 scans SOURCE
// TEXT for candidates, so a class assembled from a shared fragment
// (`dark:${FILTER}`) is invisible to it and no rule is emitted at all — the
// filter then silently does nothing. Guarded by the source assertion in
// snapshot-theme.test.ts.

/** For a preview that holds the snapshot and can decide up front. */
const INVERT = 'dark:[filter:invert(93%)_hue-rotate(180deg)]';

/** For a page embed, which is a plain `<img>` rendered by a static
 *  `renderHTML` with no theme and no data in hand. The class ships on every
 *  embed; `useDrawEmbedTheme` stamps `data-draw-theme="invert"` once it has
 *  checked the snapshot, so the default is today's un-inverted rendering and
 *  nothing ever flashes through a wrong state. */
export const DRAW_EMBED_CLASS =
  'dark:data-[draw-theme=invert]:[filter:invert(93%)_hue-rotate(180deg)]';

/**
 * Whether a snapshot places a pasted raster image.
 *
 * Such a drawing must NOT be inverted. Upstream cancels its own inversion per
 * image element (it applies `invert(100%) hue-rotate(180deg) saturate(1.25)` to
 * raster images so a photo isn't shown as a negative), and one filter over a
 * flat `<img>` cannot do that. Since every surface must render a snapshot as an
 * `<img>` and never as inline markup — the security property the whole
 * validator design rests on, docs/draw.md §4 — the honest answer is to leave
 * those light rather than negate the photo.
 *
 * Read off the snapshot rather than off `file_refs`: the snapshot is the thing
 * actually being displayed, so a scene that no longer places an image it once
 * held gives the right answer here, and no surface needs a database flag
 * plumbed to it.
 */
export function snapshotPlacesImage(svg: string): boolean {
  return /<image[\s/>]/i.test(svg);
}

/** The class for an `<img>` showing a snapshot the caller already holds. */
export function drawSnapshotClass(svg: string | null | undefined): string {
  if (!svg) return '';
  return snapshotPlacesImage(svg) ? '' : INVERT;
}
