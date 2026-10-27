/**
 * The maths of the live canvas's zoom and pan (src/zoom.ts): a view is the
 * SVG `viewBox` shown in a viewport of `vp` pixels. Pure, so the tests run
 * it without a browser. The drawing itself never changes: zoom is a view of
 * it, and the export is always the whole drawing.
 *
 * The view keeps the viewport's aspect, so one number is its scale (screen
 * pixels per drawing unit) and `preserveAspectRatio` never letterboxes it.
 */

export type View = { x: number; y: number; w: number; h: number };
export type Size = { w: number; h: number };
export type Limits = { min: number; max: number };

/** Text smaller than this on screen does not read: the controls show when
 *  the drawing's smallest text would be drawn smaller than this at the size
 *  it fits the frame at (or when it does not fit the frame at all). */
export const MIN_READABLE_TEXT_PX = 6;
/** How far past the frame's height a drawing may run before it counts as
 *  not fitting. */
export const OVERFLOW_SLACK_PX = 24;
/** The most a view magnifies: eight drawing pixels to one. */
export const MAX_SCALE = 8;
/** One step of the + and - buttons and keys. */
export const ZOOM_STEP = 1.25;

/** Screen pixels per drawing unit. */
export function scaleOf(view: View, vp: Size): number {
  return vp.w / view.w;
}

/** The view of `scale` centred on (cx, cy). */
export function viewAt(cx: number, cy: number, scale: number, vp: Size): View {
  const w = vp.w / scale;
  const h = vp.h / scale;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** The whole drawing in the viewport, centred. */
export function fitView(base: View, vp: Size): View {
  const scale = Math.min(vp.w / base.w, vp.h / base.h);
  return viewAt(base.x + base.w / 2, base.y + base.h / 2, scale, vp);
}

/** The drawing at its own size (100%), keeping the view's centre. */
export function actualView(view: View, vp: Size): View {
  return viewAt(view.x + view.w / 2, view.y + view.h / 2, 1, vp);
}

/** How the page shows a drawing without zoom: as wide as the frame (never
 *  enlarged), from its top. The view a zoomable drawing opens on. */
export function widthView(base: View, vp: Size): View {
  const scale = Math.min(1, vp.w / base.w);
  const w = vp.w / scale;
  const h = vp.h / scale;
  // Centred across, from the top down (a tall drawing reads from its top).
  const y = h >= base.h ? base.y - (h - base.h) / 2 : base.y;
  return { x: base.x - (w - base.w) / 2, y, w, h };
}

/** The scales a view may take: from half of what fits the whole drawing
 *  (never more than 1) up to MAX_SCALE. */
export function limitsFor(base: View, vp: Size): Limits {
  const fit = Math.min(vp.w / base.w, vp.h / base.h);
  return { min: Math.min(fit, 1) / 2, max: MAX_SCALE };
}

/** Keep the view's centre on the drawing, so it cannot be panned away. */
export function clampView(view: View, base: View): View {
  const cx = Math.min(base.x + base.w, Math.max(base.x, view.x + view.w / 2));
  const cy = Math.min(base.y + base.h, Math.max(base.y, view.y + view.h / 2));
  return { ...view, x: cx - view.w / 2, y: cy - view.h / 2 };
}

/** Zoom by `factor` about the viewport point (px, py): the drawing point
 *  under it stays under it. The scale stays within `limits`. */
export function zoomAt(
  view: View,
  vp: Size,
  factor: number,
  px: number,
  py: number,
  limits: Limits,
): View {
  const s0 = scaleOf(view, vp);
  const s1 = Math.min(limits.max, Math.max(limits.min, s0 * factor));
  const ux = view.x + px / s0;
  const uy = view.y + py / s0;
  const w = vp.w / s1;
  const h = vp.h / s1;
  return { x: ux - px / s1, y: uy - py / s1, w, h };
}

/** Move the view by a drag of (dx, dy) screen pixels: the drawing follows
 *  the pointer. */
export function panBy(view: View, vp: Size, dx: number, dy: number): View {
  const s = scaleOf(view, vp);
  return { ...view, x: view.x - dx / s, y: view.y - dy / s };
}

/** A view that shows `box` (a drawing element) with room around it: close
 *  enough to read, never smaller than fitting the whole drawing, at most 2x. */
export function focusView(box: View, base: View, vp: Size): View {
  const fit = Math.min(vp.w / base.w, vp.h / base.h);
  const want = Math.min(vp.w / (box.w + 240), vp.h / (box.h + 240));
  const scale = Math.min(2, Math.max(fit, Math.min(1, want)));
  return viewAt(box.x + box.w / 2, box.y + box.h / 2, scale, vp);
}

/**
 * Whether a drawing needs the zoom controls: it does not fit the frame at a
 * readable size. Shown as the page shows it (as wide as the frame, never
 * enlarged), it either runs past the frame's height, or its smallest text
 * would be drawn under MIN_READABLE_TEXT_PX.
 */
export function needsZoom(base: Size, vp: Size, smallestText: number): boolean {
  const scale = Math.min(1, vp.w / base.w);
  // A few pixels over is not worth a toolbar (a window sized to the
  // drawing's estimate, as the render harness sizes it, must not get one).
  const overflows = base.h * scale > vp.h + OVERFLOW_SLACK_PX;
  const tiny = smallestText * scale < MIN_READABLE_TEXT_PX;
  return overflows || tiny;
}

/** A `viewBox` attribute value. */
export function viewBoxText(v: View): string {
  const r = (n: number) => String(Math.round(n * 100) / 100);
  return `${r(v.x)} ${r(v.y)} ${r(v.w)} ${r(v.h)}`;
}

/** A `viewBox` attribute read back, or null. */
export function parseViewBox(text: string | null): View | null {
  const p = (text ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n)) || p[2]! <= 0 || p[3]! <= 0) return null;
  return { x: p[0]!, y: p[1]!, w: p[2]!, h: p[3]! };
}
