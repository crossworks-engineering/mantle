/**
 * What focus mode does to a master-detail screen.
 *
 * The shell already hides its own chrome, but on a list screen that still
 * leaves the list column beside the content — which is exactly the thing you
 * turned focus mode on to get away from. So the list and its resize handle go
 * too, and the preview takes the full width.
 *
 * The list is HIDDEN, never unmounted: its search box, scroll position and
 * pagination survive the round trip, so leaving focus mode puts the screen
 * back exactly as it was rather than reloading it.
 */

/** `gridTemplateColumns` for a list screen whose left column is drag-resizable
 *  (Pages). The width is inline because the user drags it, so focus mode has to
 *  override it there rather than in a class. */
export function focusGridColumns(zen: boolean, listWidth: number): string {
  return zen ? 'minmax(0, 1fr)' : `${listWidth}px minmax(0, 1fr)`;
}

/** The same for a fixed-width left column (Draw). Both arms are written out in
 *  full: Tailwind v4 scans source text, so a class built from a variable emits
 *  no rule and the column silently keeps its default width. */
export function focusGridClass(zen: boolean): string {
  return zen ? 'md:grid-cols-[minmax(0,1fr)]' : 'md:grid-cols-[360px_1fr]';
}
