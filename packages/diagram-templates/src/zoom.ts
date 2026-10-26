/**
 * Zoom and pan for an SVG in a live canvas: `zoomable(target, options)`.
 *
 * The diagram templates mount it on their drawing; any hand-made canvas can
 * opt in with one call (`import { zoomable } from
 * '@mantle/diagram-templates/browser'`). It changes only the SVG's
 * `viewBox` (a view), never the drawing: an export, a print and
 * `window.diagram.exportSvg()` are always the whole drawing.
 *
 * When it shows (mode):
 *  - 'auto' (the default): only when the drawing does not fit the frame at
 *    a readable size (zoom-math.ts needsZoom: it runs past the frame's
 *    height, or its smallest text would be drawn under 6 px). Judged again
 *    on every resize and every refresh (a set's page switch).
 *  - 'on': always; 'off': never.
 * Hidden, it does nothing at all: wheel, drag and keys reach the page as
 * before, so nothing zooms by surprise. A headless render (a look, a
 * poster, an export picture: the render harness marks its pages, RENDER_FLAG)
 * is always 'off': the picture is the whole drawing, never the toolbar.
 *
 * Shown: Ctrl (or Cmd) + wheel and a trackpad pinch (a wheel with ctrlKey)
 * zoom about the pointer; a plain wheel pans the drawing while it is zoomed
 * in past the fit, and scrolls the page as before at the fit or once the
 * view reaches the drawing's edge (so a reader inside a page is never
 * trapped); drag pans, a double click zooms in (with Shift, out), two
 * fingers pinch and drag; the buttons are zoom out, zoom in, fit page and
 * 100%; keys + and - zoom, 0 fits, the arrows pan once zoomed in past the
 * fit (at the fit they are left to the page: a set's arrows still step its
 * pages).
 *
 * Inside the canvas sandbox: no network, nothing stored, nothing outside
 * this document touched.
 */
import {
  MIN_READABLE_TEXT_PX,
  ZOOM_STEP,
  actualView,
  clampView,
  fitView,
  focusView,
  limitsFor,
  needsZoom,
  panBy,
  parseViewBox,
  scaleOf,
  viewAt,
  viewBoxText,
  widthView,
  zoomAt,
  type Size,
  type View,
} from './runtime/zoom-math.ts';

export type ZoomMode = 'auto' | 'on' | 'off';

/** The global the canvas render harness sets on every page it draws
 *  (@mantle/tools canvas-render RENDER_INIT, and this package's own
 *  scripts/render.ts): a headless render, where the zoom stays off. */
export const RENDER_FLAG = '__mantleRender';

/** Whether this window is a headless render (RENDER_FLAG). */
export function isHeadlessRender(win: Window | null | undefined): boolean {
  try {
    return (win as unknown as Record<string, unknown> | null)?.[RENDER_FLAG] === true;
  } catch {
    return false;
  }
}

export type ZoomOptions = {
  /** 'auto' (default): only when the drawing does not fit at a readable
   *  size; 'on': always; 'off': never. */
  mode?: ZoomMode;
  /** Where the buttons go: 'frame' (default) fixed to the bottom right of
   *  the window; 'inside' in the corner of the target (several zoomable
   *  drawings on one page). */
  controls?: 'frame' | 'inside';
  /** The viewport height while zoomable: 'fill' (default) down to the
   *  bottom of the window, a number of pixels, or a function that says. */
  height?: 'fill' | number | (() => number);
};

export type ZoomController = {
  /** Whether the controls show (and the gestures act). */
  readonly active: boolean;
  /** Read the SVG again (a new page drawn into the target) and judge again
   *  whether the controls show. */
  refresh(): void;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  actual(): void;
  /** Show this element of the drawing up close (a link's focus). False when
   *  the controls are hidden (the caller scrolls the page instead). */
  focus(el: Element): boolean;
  /** The view shown, or null when hidden. */
  view(): View | null;
  destroy(): void;
};

const CSS = `
.diagram-zoom{display:flex;gap:4px;align-items:center;padding:4px;background:rgba(255,255,255,.94);border:1px solid #bfc0c0;border-radius:8px;box-shadow:0 1px 4px rgba(45,49,66,.15);font:12px/1 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;z-index:20}
.diagram-zoom[data-at=frame]{position:fixed;right:12px;bottom:12px}
.diagram-zoom[data-at=inside]{position:absolute;right:8px;bottom:8px}
.diagram-zoom[hidden]{display:none}
.diagram-zoom button{font:inherit;min-width:32px;height:28px;padding:0 8px;color:#2d3142;background:#fff;border:1px solid #bfc0c0;border-radius:6px;cursor:pointer}
.diagram-zoom button:hover{background:#ececec}
.diagram-zoom button:focus-visible{outline:2px solid #1d5fa8;outline-offset:1px}
.diagram-zoom output{min-width:44px;text-align:center;color:#4f5d75}
svg.diagram-zoomed{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;display:block}
svg.diagram-zoomed.diagram-dragging{cursor:grabbing}
@media print{.diagram-zoom{display:none!important}}
`.trim();

const STYLE_ID = 'diagram-zoom-style';
const BASE_ATTR = 'data-zoom-base';

/** The smallest font size the drawing writes, in drawing units. */
function smallestText(svg: SVGSVGElement): number {
  let min = Infinity;
  for (const t of svg.querySelectorAll('text[font-size]')) {
    const n = Number(t.getAttribute('font-size'));
    if (Number.isFinite(n) && n > 0) min = Math.min(min, n);
  }
  return Number.isFinite(min) ? min : 12;
}

/** Where a plain wheel may take the view: on each axis no further out than
 *  the drawing's edge at the viewport's edge (a view already past it stays,
 *  and only comes back), and nowhere on an axis the whole drawing already
 *  shows. When it cannot move, the wheel is the page's. */
function wheelPan(prev: View, next: View, base: View): View {
  const axis = (p: number, n: number, size: number, from: number, len: number) => {
    if (size >= len) return p;
    const lo = Math.min(from, p);
    const hi = Math.max(from + len - size, p);
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    ...next,
    x: axis(prev.x, next.x, prev.w, base.x, base.w),
    y: axis(prev.y, next.y, prev.h, base.y, base.h),
  };
}

export function zoomable(
  target: HTMLElement | SVGSVGElement,
  options: ZoomOptions = {},
): ZoomController {
  const doc = target.ownerDocument;
  const win = doc.defaultView!;
  const isSvg = target.tagName.toLowerCase() === 'svg';
  const container: HTMLElement = isSvg
    ? (target.parentElement as HTMLElement)
    : (target as HTMLElement);
  // A render's picture is the whole drawing, whatever the data asks.
  const mode = isHeadlessRender(win) ? 'off' : (options.mode ?? 'auto');
  const placement = options.controls ?? 'frame';

  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  // The buttons.
  const bar = doc.createElement('div');
  bar.className = 'diagram-zoom';
  bar.setAttribute('data-at', placement);
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Zoom');
  bar.hidden = true;
  const btn = (text: string, label: string, act: () => void) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', act);
    bar.appendChild(b);
    return b;
  };
  btn('−', 'Zoom out', () => api.zoomOut());
  const readout = doc.createElement('output');
  readout.setAttribute('aria-live', 'polite');
  readout.setAttribute('aria-label', 'Zoom level');
  bar.appendChild(readout);
  btn('+', 'Zoom in', () => api.zoomIn());
  btn('Fit', 'Fit page', () => api.fit());
  btn('100%', 'Actual size (100%)', () => api.actual());
  if (placement === 'inside') {
    if (win.getComputedStyle(container).position === 'static')
      container.style.position = 'relative';
    container.appendChild(bar);
  } else doc.body.appendChild(bar);

  let svg: SVGSVGElement | null = null;
  let base: View | null = null;
  let view: View | null = null;
  let vp: Size = { w: 1, h: 1 };
  let active = false;
  let printing = false;

  const svgOf = (): SVGSVGElement | null =>
    isSvg ? (target as SVGSVGElement) : container.querySelector('svg');

  const viewport = (): Size => {
    const r = container.getBoundingClientRect();
    const w = Math.max(1, container.clientWidth || r.width);
    const h =
      typeof options.height === 'number'
        ? options.height
        : typeof options.height === 'function'
          ? Math.max(120, options.height())
          : Math.max(200, win.innerHeight - Math.max(0, r.top) - 16);
    return { w, h };
  };

  const apply = () => {
    if (!svg || !view) return;
    svg.setAttribute('viewBox', viewBoxText(view));
    readout.textContent = `${Math.round(scaleOf(view, vp) * 100)}%`;
  };

  const restore = () => {
    if (!svg || !base) return;
    svg.setAttribute('viewBox', viewBoxText(base));
    svg.classList.remove('diagram-zoomed', 'diagram-dragging');
    svg.style.removeProperty('width');
    svg.style.removeProperty('height');
    svg.style.removeProperty('max-width');
  };

  const hide = () => {
    if (active) restore();
    active = false;
    view = null;
    bar.hidden = true;
  };

  /** Show the controls, the SVG filling the viewport, at `start`. */
  const activate = (start: View) => {
    active = true;
    bar.hidden = false;
    svg!.classList.add('diagram-zoomed');
    svg!.style.width = `${vp.w}px`;
    svg!.style.height = `${vp.h}px`;
    svg!.style.maxWidth = 'none';
    view = start;
    apply();
  };

  /** Read the SVG and judge whether the controls show. `fresh`: a new
   *  drawing (it opens as the page would show it); otherwise a resize
   *  keeps the centre and the scale. */
  const judge = (fresh: boolean) => {
    if (printing) return;
    const next = svgOf();
    if (next !== svg) {
      hide();
      svg = next;
      fresh = true;
    }
    if (!svg) return hide();
    // The drawing's own viewBox, kept on the element so a judge after a
    // zoom never reads the zoomed one back.
    if (!svg.hasAttribute(BASE_ATTR))
      svg.setAttribute(BASE_ATTR, svg.getAttribute('viewBox') ?? '');
    base = parseViewBox(svg.getAttribute(BASE_ATTR));
    if (!base) return hide();
    const keep =
      !fresh && active && view
        ? { cx: view.x + view.w / 2, cy: view.y + view.h / 2, s: scaleOf(view, vp) }
        : null;
    // Measured as the page lays it out without zoom.
    hide();
    if (mode === 'off') return;
    vp = viewport();
    if (mode === 'auto' && !needsZoom(base, vp, smallestText(svg))) return;
    activate(keep ? clampView(viewAt(keep.cx, keep.cy, keep.s, vp), base) : widthView(base, vp));
  };

  const zoomBy = (factor: number, px = vp.w / 2, py = vp.h / 2) => {
    if (!active || !view || !base) return;
    view = clampView(zoomAt(view, vp, factor, px, py, limitsFor(base, vp)), base);
    apply();
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = svg!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Gestures: each acts only while the controls show.
  const atFit = () => !view || !base || scaleOf(view, vp) <= scaleOf(fitView(base, vp), vp) * 1.01;
  const onWheel = (e: WheelEvent) => {
    if (!active || !svg || !view || !base || !svg.contains(e.target as Node)) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vp.h : 1;
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd + wheel zooms; a trackpad pinch arrives as a wheel with
      // ctrlKey and small deltas. One event zooms at most one step (a
      // mouse wheel's tick is a large delta).
      e.preventDefault();
      const most = Math.log(ZOOM_STEP);
      const factor = Math.exp(Math.max(-most, Math.min(most, -e.deltaY * unit * 0.01)));
      const p = local(e);
      zoomBy(factor, p.x, p.y);
      return;
    }
    // A plain wheel is the page's at the fit, and once the view cannot move
    // that way (the drawing's edge): it scrolls the page as before.
    if (atFit()) return;
    const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
    const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
    const next = wheelPan(view, panBy(view, vp, -dx, -dy), base);
    if (Math.abs(next.x - view.x) < 1e-6 && Math.abs(next.y - view.y) < 1e-6) return;
    e.preventDefault();
    view = next;
    apply();
  };
  const pointers = new Map<number, { x: number; y: number }>();
  let dragFrom: { x: number; y: number } | null = null;
  let moved = false;
  let pinch: { d: number; mid: { x: number; y: number } } | null = null;
  /** Forget every pointer: a pointerup the page never saw (released
   *  outside the frame, a lost capture) must not leave one behind, or the
   *  next drag would act as a pinch. */
  const forget = () => {
    pointers.clear();
    pinch = null;
    dragFrom = null;
    svg?.classList.remove('diagram-dragging');
  };
  const onDown = (e: PointerEvent) => {
    if (!active || !svg || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // A new first touch or click starts afresh.
    if (e.isPrimary) forget();
    pointers.set(e.pointerId, local(e));
    moved = false;
    if (pointers.size === 1) dragFrom = local(e);
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch = {
        d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }
  };
  const onMove = (e: PointerEvent) => {
    if (!active || !view || !pointers.has(e.pointerId)) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      view = panBy(view, vp, mid.x - pinch.mid.x, mid.y - pinch.mid.y);
      view = zoomAt(view, vp, d / pinch.d, mid.x, mid.y, limitsFor(base!, vp));
      view = clampView(view, base!);
      pinch = { d, mid };
      moved = true;
      apply();
      return;
    }
    if (!dragFrom) return;
    const dx = p.x - dragFrom.x;
    const dy = p.y - dragFrom.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) {
      moved = true;
      svg!.classList.add('diagram-dragging');
      try {
        svg!.setPointerCapture(e.pointerId);
      } catch {
        /* a synthetic event has no capture to take */
      }
    }
    view = clampView(panBy(view, vp, dx, dy), base!);
    dragFrom = p;
    apply();
  };
  const onUp = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      dragFrom = null;
      svg?.classList.remove('diagram-dragging');
    }
  };
  // A drag is not a click: the link or the evidence under the pointer at
  // the end of a drag does not open.
  const onClick = (e: MouseEvent) => {
    if (active && moved) {
      e.stopPropagation();
      e.preventDefault();
      moved = false;
    }
  };
  const onDbl = (e: MouseEvent) => {
    if (!active || !svg || !svg.contains(e.target as Node)) return;
    if ((e.target as Element).closest?.('[data-link],[data-check]')) return;
    e.preventDefault();
    const p = local(e);
    zoomBy(e.shiftKey ? 1 / 2 : 2, p.x, p.y);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!active || !view || !base || e.defaultPrevented) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (t?.closest?.('[role=dialog]')) return;
    const k = e.key;
    if (k === '+' || k === '=') api.zoomIn();
    else if (k === '-' || k === '_') api.zoomOut();
    else if (k === '0') api.fit();
    else if (k.startsWith('Arrow')) {
      // At the fit (or less) the arrows are the page's: a set steps pages.
      const fit = fitView(base, vp);
      if (scaleOf(view, vp) <= scaleOf(fit, vp) * 1.01) return;
      const step = 0.15;
      const dx = k === 'ArrowLeft' ? 1 : k === 'ArrowRight' ? -1 : 0;
      const dy = k === 'ArrowUp' ? 1 : k === 'ArrowDown' ? -1 : 0;
      view = clampView(panBy(view, vp, dx * vp.w * step, dy * vp.h * step), base);
      apply();
    } else return;
    e.preventDefault();
  };
  // A resize judges again once per frame, not once per event.
  let resizeFrame = 0;
  const onResize = () => {
    if (resizeFrame) return;
    const raf = win.requestAnimationFrame?.bind(win) ?? ((f: () => void) => win.setTimeout(f, 16));
    resizeFrame = raf(() => {
      resizeFrame = 0;
      judge(false);
    });
  };
  // A print is the whole drawing, never the view.
  const onBeforePrint = () => {
    printing = true;
    if (active) restore();
  };
  const onAfterPrint = () => {
    printing = false;
    if (active) judge(false);
  };

  container.addEventListener('wheel', onWheel, { passive: false });
  container.addEventListener('pointerdown', onDown);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerup', onUp);
  container.addEventListener('pointercancel', onUp);
  container.addEventListener('lostpointercapture', onUp);
  container.addEventListener('pointerleave', onUp);
  container.addEventListener('click', onClick, true);
  container.addEventListener('dblclick', onDbl);
  // Capture: before a set's own arrow keys, which then see defaultPrevented.
  doc.addEventListener('keydown', onKey, true);
  win.addEventListener('resize', onResize);
  win.addEventListener('beforeprint', onBeforePrint);
  win.addEventListener('afterprint', onAfterPrint);

  const api: ZoomController = {
    get active() {
      return active;
    },
    refresh: () => judge(true),
    zoomIn: () => zoomBy(ZOOM_STEP),
    zoomOut: () => zoomBy(1 / ZOOM_STEP),
    fit: () => {
      if (!active || !base) return;
      view = fitView(base, vp);
      apply();
    },
    actual: () => {
      if (!active || !view || !base) return;
      view = clampView(actualView(view, vp), base);
      apply();
    },
    focus: (el: Element) => {
      if (!active || !base || !svg || !view) return false;
      // The element's box in drawing units, from where it is on screen in
      // the view shown (the view keeps the viewport's aspect: no letterbox).
      const r = el.getBoundingClientRect();
      const sr = svg.getBoundingClientRect();
      const s = scaleOf(view, vp);
      const box: View = {
        x: view.x + (r.left - sr.left) / s,
        y: view.y + (r.top - sr.top) / s,
        w: r.width / s,
        h: r.height / s,
      };
      view = clampView(focusView(box, base, vp), base);
      apply();
      return true;
    },
    view: () => (active && view ? { ...view } : null),
    destroy: () => {
      if (active) restore();
      active = false;
      bar.remove();
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('pointerdown', onDown);
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerup', onUp);
      container.removeEventListener('pointercancel', onUp);
      container.removeEventListener('lostpointercapture', onUp);
      container.removeEventListener('pointerleave', onUp);
      container.removeEventListener('click', onClick, true);
      container.removeEventListener('dblclick', onDbl);
      doc.removeEventListener('keydown', onKey, true);
      win.removeEventListener('resize', onResize);
      win.removeEventListener('beforeprint', onBeforePrint);
      win.removeEventListener('afterprint', onAfterPrint);
    },
  };
  judge(true);
  return api;
}

export { MIN_READABLE_TEXT_PX };
