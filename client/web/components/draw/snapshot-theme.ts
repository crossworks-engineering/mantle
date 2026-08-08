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

/** Excalidraw's own `THEME_FILTER`, copied deliberately rather than imported —
 *  it is a private constant in the package, and the point is that our surfaces
 *  match the canvas. Re-check it on a pin bump, alongside `draw-theme.css`. */
const DARK_INVERT = 'dark:[filter:invert(93%)_hue-rotate(180deg)]';

/**
 * The class for an `<img>` showing a drawing's snapshot.
 *
 * `hasImages` drawings opt OUT: the editor cancels its inversion per image
 * element (upstream applies `invert(100%) hue-rotate(180deg) saturate(1.25)` to
 * raster images so a pasted photo isn't shown as a negative), and one filter
 * over a flat `<img>` cannot do that. Since every surface must render a
 * snapshot as an `<img>` and never as inline markup — that is the security
 * property the whole validator design rests on (docs/draw.md §4) — the honest
 * answer for those is to leave them light rather than negate the photo.
 */
export function drawSnapshotClass(hasImages: boolean): string {
  return hasImages ? '' : DARK_INVERT;
}
