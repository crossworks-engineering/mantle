/**
 * Zoom and pan: the view maths (runtime/zoom-math.ts) and the helper's
 * events in a real DOM (jsdom; it has no layout, so sizes are set by hand).
 * When the controls hide nothing zooms; when they show, wheel, drag, double
 * click, keys and buttons move the viewBox and nothing else: the drawing
 * and its export stay whole.
 */
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_READABLE_TEXT_PX,
  actualView,
  clampView,
  fitView,
  focusView,
  limitsFor,
  needsZoom,
  panBy,
  parseViewBox,
  scaleOf,
  viewBoxText,
  widthView,
  zoomAt,
} from './runtime/zoom-math.ts';
import {
  READOUT_SETTLE_MS,
  RENDER_FLAG,
  touchActionFor,
  zoomable,
  type ZoomController,
} from './zoom.ts';
import { estimateMeasurer, render } from './index.ts';
import { buildCanvas } from './canvas.ts';
import { mount } from './browser.ts';

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe('the view maths', () => {
  const base = { x: 0, y: 0, w: 2000, h: 1000 };
  const vp = { w: 800, h: 600 };

  it('fits the whole drawing, centred, at the viewport aspect', () => {
    const v = fitView(base, vp);
    near(scaleOf(v, vp), 0.4);
    near(v.w / v.h, vp.w / vp.h);
    near(v.x + v.w / 2, 1000);
    near(v.y + v.h / 2, 500);
  });

  it('opens as the page shows it: as wide as the frame, from the top', () => {
    const tall = { x: 0, y: 0, w: 600, h: 3000 };
    const v = widthView(tall, vp);
    near(scaleOf(v, vp), 1);
    near(v.y, 0);
    // A drawing narrower than the frame is never enlarged.
    near(scaleOf(widthView({ x: 0, y: 0, w: 300, h: 200 }, vp), vp), 1);
  });

  it('zooms about the pointer: the point under it stays', () => {
    const v0 = fitView(base, vp);
    const px = 200;
    const py = 150;
    const before = { x: v0.x + px / scaleOf(v0, vp), y: v0.y + py / scaleOf(v0, vp) };
    const v1 = zoomAt(v0, vp, 2, px, py, limitsFor(base, vp));
    near(scaleOf(v1, vp), 0.8);
    near(v1.x + px / scaleOf(v1, vp), before.x);
    near(v1.y + py / scaleOf(v1, vp), before.y);
  });

  it('keeps the scale within limits', () => {
    const lim = limitsFor(base, vp);
    near(lim.min, 0.2);
    expect(lim.max).toBe(MAX_SCALE);
    const v = fitView(base, vp);
    near(scaleOf(zoomAt(v, vp, 1000, 0, 0, lim), vp), MAX_SCALE);
    near(scaleOf(zoomAt(v, vp, 0.0001, 0, 0, lim), vp), lim.min);
  });

  it('pans with the pointer and cannot pan the drawing away', () => {
    const v = actualView(fitView(base, vp), vp);
    const p = panBy(v, vp, 100, -50);
    near(p.x, v.x - 100);
    near(p.y, v.y + 50);
    const far = clampView({ ...v, x: 99999, y: -99999 }, base);
    near(far.x + far.w / 2, base.x + base.w);
    near(far.y + far.h / 2, base.y);
  });

  it('a focus shows the element up close, never smaller than the fit, at most 2x', () => {
    const f = focusView({ x: 1500, y: 800, w: 40, h: 12 }, base, vp);
    near(f.x + f.w / 2, 1520);
    near(f.y + f.h / 2, 806);
    expect(scaleOf(f, vp)).toBeGreaterThanOrEqual(0.4);
    expect(scaleOf(f, vp)).toBeLessThanOrEqual(2);
  });

  it('decides when the controls show', () => {
    // Fits, text readable: no controls.
    expect(needsZoom({ w: 700, h: 500 }, vp, 8)).toBe(false);
    // Runs past the frame's height: controls.
    expect(needsZoom({ w: 700, h: 900 }, vp, 8)).toBe(true);
    // A few pixels over is not worth a toolbar.
    expect(needsZoom({ w: 700, h: 610 }, vp, 8)).toBe(false);
    // Fits only shrunk so far that 8 px text reads under the threshold.
    expect(needsZoom({ w: 1200, h: 300 }, vp, 8)).toBe(true);
    expect(8 * (800 / 1200)).toBeLessThan(MIN_READABLE_TEXT_PX);
    expect(needsZoom({ w: 900, h: 300 }, vp, 8)).toBe(false);
  });

  it('writes and reads a viewBox', () => {
    expect(viewBoxText({ x: 1.234, y: -2, w: 300.456, h: 20 })).toBe('1.23 -2 300.46 20');
    expect(parseViewBox('0 0 10 20')).toEqual({ x: 0, y: 0, w: 10, h: 20 });
    expect(parseViewBox('0 0 -1 20')).toBeNull();
    expect(parseViewBox(null)).toBeNull();
  });
});

/** A page with one drawing of `w` x `h`, in a frame of `vw` x `vh`. */
function page(w: number, h: number, vw = 800, vh = 600, fontSize = 9) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><main id="diagram"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><g data-line="L1"><text font-size="${fontSize}">L1</text><rect x="${w - 60}" y="${h - 30}" width="40" height="12"/></g></svg></main></body></html>`,
    { pretendToBeVisual: true },
  );
  const win = dom.window;
  Object.defineProperty(win, 'innerHeight', { value: vh, configurable: true });
  Object.defineProperty(win, 'innerWidth', { value: vw, configurable: true });
  const main = win.document.getElementById('diagram')!;
  Object.defineProperty(main, 'clientWidth', { value: vw, configurable: true });
  main.getBoundingClientRect = () => ({ top: 0, left: 0, width: vw, height: vh }) as DOMRect;
  const svg = main.querySelector('svg')!;
  // The SVG fills the viewport while zoomable (top 0, so the viewport is
  // vh - 16 tall).
  svg.getBoundingClientRect = () => ({ top: 0, left: 0, width: vw, height: vh - 16 }) as DOMRect;
  return { dom, win, doc: win.document, main, svg };
}

const vb = (svg: Element) => parseViewBox(svg.getAttribute('viewBox'))!;

describe('zoomable in a page', () => {
  let z: ZoomController | undefined;
  afterEach(() => z?.destroy());

  it('auto: a drawing that fits gets no controls, and nothing zooms', () => {
    const { doc, main, svg, win } = page(600, 400);
    z = zoomable(main);
    expect(z.active).toBe(false);
    expect(doc.querySelector('.diagram-zoom')!.hasAttribute('hidden')).toBe(true);
    const wheel = new win.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    svg.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(svg.getAttribute('viewBox')).toBe('0 0 600 400');
    const key = new win.KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true });
    doc.body.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(svg.getAttribute('viewBox')).toBe('0 0 600 400');
  });

  it('auto: a drawing taller than the frame gets accessible controls', () => {
    const { doc, main, svg } = page(700, 2000);
    z = zoomable(main);
    expect(z.active).toBe(true);
    const bar = doc.querySelector('.diagram-zoom')!;
    expect(bar.hasAttribute('hidden')).toBe(false);
    expect(bar.getAttribute('role')).toBe('toolbar');
    const labels = [...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Zoom out', 'Zoom in', 'Fit page', 'Actual size (100%)']);
    // It opens as the page showed it: full width, from the top.
    const v = vb(svg);
    near(v.x, -50);
    near(v.y, 0);
    expect(svg.classList.contains('diagram-zoomed')).toBe(true);
  });

  it('auto: tiny text at the fitted size gets controls', () => {
    const { main } = page(3000, 500, 800, 600, 8);
    z = zoomable(main);
    expect(z.active).toBe(true);
  });

  it('off forces them off, on forces them on', () => {
    const big = page(700, 2000);
    z = zoomable(big.main, { mode: 'off' });
    expect(z.active).toBe(false);
    expect(big.svg.getAttribute('viewBox')).toBe('0 0 700 2000');
    z.destroy();
    const small = page(300, 200);
    z = zoomable(small.main, { mode: 'on' });
    expect(z.active).toBe(true);
  });

  it('wheel, keys, buttons, double click and drag move the view', () => {
    const { doc, main, svg, win } = page(1600, 2000);
    z = zoomable(main);
    const s0 = 800 / vb(svg).w;
    // Ctrl + wheel (a trackpad pinch too) zooms, one step at most.
    const wheel = new win.WheelEvent('wheel', {
      deltaY: -200,
      clientX: 100,
      clientY: 100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    svg.querySelector('text')!.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    const s1 = 800 / vb(svg).w;
    expect(s1).toBeCloseTo(s0 * 1.25, 3);

    const press = (key: string) => {
      const e = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      doc.body.dispatchEvent(e);
      return e;
    };
    expect(press('+').defaultPrevented).toBe(true);
    expect(800 / vb(svg).w).toBeCloseTo(s1 * 1.25, 3);
    press('-');
    expect(800 / vb(svg).w).toBeCloseTo(s1, 3);
    // Zoomed in past the fit, the arrows pan.
    const before = vb(svg);
    expect(press('ArrowRight').defaultPrevented).toBe(true);
    expect(vb(svg).x).toBeGreaterThan(before.x);
    press('0');
    const fit = vb(svg);
    near(800 / fit.w, Math.min(800 / 1600, 584 / 2000));
    // At the fit the arrows are the page's (a set steps its pages).
    expect(press('ArrowRight').defaultPrevented).toBe(false);

    const buttons = [...doc.querySelectorAll('.diagram-zoom button')] as HTMLButtonElement[];
    buttons[3]!.click(); // 100%
    near(800 / vb(svg).w, 1);
    buttons[0]!.click(); // zoom out
    near(800 / vb(svg).w, 0.8);
    buttons[1]!.click(); // zoom in
    near(800 / vb(svg).w, 1);
    expect(doc.querySelector('.diagram-zoom output')!.textContent).toBe('100%');

    const dbl = new win.MouseEvent('dblclick', {
      clientX: 400,
      clientY: 300,
      bubbles: true,
      cancelable: true,
    });
    svg.dispatchEvent(dbl);
    near(800 / vb(svg).w, 2);

    // A drag pans; the click at its end does not reach the drawing.
    const at = vb(svg);
    const P = win.PointerEvent ?? win.MouseEvent;
    const ptr = (type: string, x: number, y: number) =>
      svg.dispatchEvent(
        new P(type, {
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          button: 0,
          pointerType: 'mouse',
        } as PointerEventInit),
      );
    let clicked = 0;
    main.addEventListener('click', () => clicked++);
    ptr('pointerdown', 100, 100);
    ptr('pointermove', 160, 140);
    ptr('pointerup', 160, 140);
    svg.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(clicked).toBe(0);
    near(vb(svg).x, at.x - 60 / 2);
    near(vb(svg).y, at.y - 40 / 2);
  });

  it("a plain wheel pans while zoomed in, and is the page's at the edge and at the fit", () => {
    const { main, svg, win } = page(1600, 2000);
    z = zoomable(main);
    const wheel = (deltaY: number) => {
      const e = new win.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
      svg.querySelector('text')!.dispatchEvent(e);
      return e;
    };
    // Opens as wide as the frame, from the top (scale 0.5, past the fit).
    const top = vb(svg);
    near(top.y, 0);
    // Up at the top: the drawing cannot move, the page scrolls.
    expect(wheel(-100).defaultPrevented).toBe(false);
    near(vb(svg).y, 0);
    // Down: the drawing pans, the page stays.
    expect(wheel(100).defaultPrevented).toBe(true);
    near(vb(svg).y, 200);
    near(800 / vb(svg).w, 0.5);
    // To the bottom edge, then the page has it again.
    for (let i = 0; i < 40; i++) wheel(100);
    const bottom = vb(svg);
    near(bottom.y + bottom.h, 2000);
    expect(wheel(100).defaultPrevented).toBe(false);
    // At the fit every plain wheel is the page's.
    z.fit();
    const fit = vb(svg);
    expect(wheel(100).defaultPrevented).toBe(false);
    expect(wheel(-100).defaultPrevented).toBe(false);
    expect(vb(svg)).toEqual(fit);
  });

  it('a stale pointer (its pointerup never came) does not turn the next drag into a pinch', () => {
    const { main, svg, win } = page(1600, 2000);
    z = zoomable(main);
    z.actual();
    const P = win.PointerEvent ?? win.MouseEvent;
    const ptr = (type: string, id: number, x: number, y: number, isPrimary = true) =>
      svg.dispatchEvent(
        new P(type, {
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
          pointerId: id,
          isPrimary,
          button: 0,
          pointerType: 'mouse',
        } as PointerEventInit),
      );
    // A press whose release happened outside the frame.
    ptr('pointerdown', 1, 100, 100);
    const at = vb(svg);
    // A new press: a plain drag, at the same scale.
    ptr('pointerdown', 2, 100, 100);
    ptr('pointermove', 2, 160, 100);
    ptr('pointerup', 2, 160, 100);
    near(800 / vb(svg).w, 800 / at.w);
    near(vb(svg).x, at.x - 60);
  });

  it('a headless render (the harness flag) never shows the controls', () => {
    const { doc, main, svg, win } = page(1600, 2000);
    Object.defineProperty(win, RENDER_FLAG, { value: true });
    z = zoomable(main, { mode: 'on' });
    expect(z.active).toBe(false);
    expect(doc.querySelector('.diagram-zoom')!.hasAttribute('hidden')).toBe(true);
    expect(svg.getAttribute('viewBox')).toBe('0 0 1600 2000');
  });

  it('a resize judges again once per frame', async () => {
    const { main, svg, win } = page(1600, 2000);
    z = zoomable(main);
    z.zoomIn();
    let reads = 0;
    const was = svg.setAttribute.bind(svg);
    svg.setAttribute = (n: string, v: string) => {
      if (n === 'viewBox') reads++;
      was(n, v);
    };
    for (let i = 0; i < 5; i++) win.dispatchEvent(new win.Event('resize'));
    expect(reads).toBe(0);
    await new Promise((r) => win.requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(3);
  });

  it('a print shows the whole drawing; the view comes back after', () => {
    const { main, svg, win } = page(1600, 2000);
    z = zoomable(main);
    z.zoomIn();
    const zoomed = svg.getAttribute('viewBox');
    win.dispatchEvent(new win.Event('beforeprint'));
    expect(svg.getAttribute('viewBox')).toBe('0 0 1600 2000');
    expect(svg.classList.contains('diagram-zoomed')).toBe(false);
    win.dispatchEvent(new win.Event('afterprint'));
    expect(svg.getAttribute('viewBox')).toBe(zoomed);
  });

  it('a refresh with a new drawing judges again (a page switch)', () => {
    const { doc, main } = page(700, 2000);
    z = zoomable(main);
    expect(z.active).toBe(true);
    main.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200"><text font-size="9">x</text></svg>';
    z.refresh();
    expect(z.active).toBe(false);
    expect(doc.querySelector('.diagram-zoom')!.hasAttribute('hidden')).toBe(true);
  });

  it('a focus moves the view to the element', () => {
    const { main, svg } = page(1600, 2000);
    z = zoomable(main);
    const rect = svg.querySelector('rect')!;
    // On screen where the element is in the opening view (scale 0.5).
    rect.getBoundingClientRect = () => ({ left: 770, top: 985, width: 20, height: 6 }) as DOMRect;
    expect(z.focus(rect)).toBe(true);
    const v = vb(svg);
    near(v.x + v.w / 2, 1560);
    near(v.y + v.h / 2, 1976);
  });
});

describe('a touch on a phone: the page scrolls past a drawing at the fit', () => {
  let z: ZoomController | undefined;
  afterEach(() => z?.destroy());
  const base = { x: 0, y: 0, w: 1600, h: 2000 };

  it('the touch-action follows the view, as the plain wheel does', () => {
    // The whole height shows (the fit, or wider): the page has up and down.
    expect(touchActionFor({ x: -100, y: -10, w: 1800, h: 2020 }, base)).toBe('pan-y');
    // Zoomed in, between the edges: the drawing has every swipe.
    expect(touchActionFor({ x: 0, y: 500, w: 800, h: 600 }, base)).toBe('none');
    // At the top edge a swipe down is the page's; at the bottom a swipe up.
    expect(touchActionFor({ x: 0, y: 0, w: 800, h: 600 }, base)).toBe('pan-up');
    expect(touchActionFor({ x: 0, y: -40, w: 800, h: 600 }, base)).toBe('pan-up');
    expect(touchActionFor({ x: 0, y: 1400, w: 800, h: 600 }, base)).toBe('pan-down');
    // Where the browser has no one-way values, an edge keeps the swipe.
    expect(touchActionFor({ x: 0, y: 0, w: 800, h: 600 }, base, false)).toBe('none');
    expect(touchActionFor({ x: -100, y: -10, w: 1800, h: 2020 }, base, false)).toBe('pan-y');
  });

  const touchPage = (oneWay: boolean) => {
    const p = page(1600, 2000);
    Object.defineProperty(p.win, 'CSS', {
      value: { supports: (prop: string, v: string) => oneWay && prop === 'touch-action' && !!v },
      configurable: true,
    });
    const ptr = (type: string, x: number, y: number, target: Element = p.svg, id = 7) =>
      target.dispatchEvent(
        new p.win.PointerEvent(type, {
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
          pointerId: id,
          isPrimary: id === 7,
          pointerType: 'touch',
        }),
      );
    return { ...p, ptr };
  };
  const ta = (svg: SVGSVGElement) => svg.style.getPropertyValue('touch-action');

  it('at the fit the SVG takes pan-y and a one-finger drag never moves it up or down', () => {
    const { main, svg, ptr } = touchPage(true);
    z = zoomable(main);
    z.fit();
    expect(ta(svg)).toBe('pan-y');
    const fit = vb(svg);
    // The moves the page sees before the browser takes the swipe.
    ptr('pointerdown', 400, 400);
    ptr('pointermove', 400, 300);
    ptr('pointermove', 400, 200);
    ptr('pointercancel', 400, 200);
    near(vb(svg).y, fit.y);
  });

  it("zoomed in at the top: a swipe down is the page's, a swipe up moves the drawing", () => {
    const { main, svg, ptr } = touchPage(true);
    z = zoomable(main);
    // Opens as wide as the frame, from the top: past the fit, at the edge.
    expect(ta(svg)).toBe('pan-up');
    const top = vb(svg);
    ptr('pointerdown', 400, 200);
    ptr('pointermove', 400, 300);
    near(vb(svg).y, top.y);
    ptr('pointerup', 400, 300);
    ptr('pointerdown', 400, 400);
    ptr('pointermove', 400, 300);
    ptr('pointermove', 400, 200);
    ptr('pointerup', 400, 200);
    near(vb(svg).y, top.y + 200 / 0.5);
    // Between the edges the drawing takes every swipe.
    expect(ta(svg)).toBe('none');
  });

  it('without one-way values an edge keeps the swipe (none)', () => {
    const { main, svg } = touchPage(false);
    z = zoomable(main);
    expect(ta(svg)).toBe('none');
    z.fit();
    expect(ta(svg)).toBe('pan-y');
  });

  it('a capture moved to the SVG does not end the drag; hidden, nothing is left set', () => {
    const { main, svg, ptr, win } = touchPage(true);
    z = zoomable(main);
    z.zoomIn();
    const text = svg.querySelector('text')!;
    const at = vb(svg);
    ptr('pointerdown', 400, 400, text);
    ptr('pointermove', 400, 380, text);
    // The element the touch began on loses its capture to the SVG.
    text.dispatchEvent(
      new win.PointerEvent('lostpointercapture', {
        bubbles: true,
        pointerId: 7,
        pointerType: 'touch',
      }),
    );
    ptr('pointermove', 400, 300);
    ptr('pointerup', 400, 300);
    expect(vb(svg).y).toBeGreaterThan(at.y + 50);
    z.destroy();
    z = undefined;
    expect(ta(svg)).toBe('');
  });

  it('the level shows at once and is said once the zoom settles', async () => {
    const { doc, main } = page(1600, 2000);
    z = zoomable(main);
    const out = doc.querySelector('.diagram-zoom output')!;
    const said = doc.querySelector('.diagram-zoom [role="status"]')!;
    expect(out.hasAttribute('aria-live')).toBe(false);
    expect(said.getAttribute('aria-live')).toBe('polite');
    await new Promise((r) => setTimeout(r, READOUT_SETTLE_MS + 50));
    const first = said.textContent;
    for (let i = 0; i < 4; i++) z.zoomIn();
    expect(out.textContent).toBe(`${Math.round((800 / vb(main.querySelector('svg')!).w) * 100)}%`);
    expect(said.textContent).toBe(first);
    await new Promise((r) => setTimeout(r, READOUT_SETTLE_MS + 50));
    expect(said.textContent).toBe(`Zoom ${out.textContent}`);
  });
});

describe('the canvas mounts zoom for its drawing, never in its export', () => {
  const data = {
    title: 'Zoom check',
    description: 'A made-up drawing taller than its frame.',
    equipment: [
      { id: 'V-1', type: 'vertical-vessel' },
      { id: 'V-2', type: 'vertical-vessel' },
    ],
    lines: [{ id: 'L1', from: 'V-1', to: 'V-2' }],
  };
  const mountIn = (d: Record<string, unknown>, vh: number) => {
    const html = buildCanvas({ template: 'pid', data: d, mode: 'import' }).replace(
      /<script type="module">[\s\S]*?<\/script>/,
      '',
    );
    const dom = new JSDOM(html, { pretendToBeVisual: true });
    const win = dom.window;
    // jsdom has no text layout: an estimate, as the Node measurer makes.
    (win.SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = function (
      this: Element,
    ) {
      return { x: 0, y: 0, width: (this.textContent ?? '').length * 6, height: 10 } as DOMRect;
    };
    Object.defineProperty(win, 'innerHeight', { value: vh, configurable: true });
    const main = win.document.getElementById('diagram')!;
    Object.defineProperty(main, 'clientWidth', { value: 800, configurable: true });
    const g = globalThis as { window?: unknown };
    const had = g.window;
    g.window = win;
    try {
      const api = mount(win.document);
      return { api, win, main };
    } finally {
      g.window = had;
    }
  };

  it('auto, forced off, forced on; the export is the whole drawing', async () => {
    const plain = render('pid', data, estimateMeasurer);
    if (!plain.ok) throw new Error(plain.errors.join());
    const tall = mountIn(data, 120);
    const out = await tall.api.ready;
    expect(out.ok).toBe(true);
    expect(tall.api.zoom?.active).toBe(true);
    tall.api.zoom!.zoomIn();
    // The export is the template's own SVG string, whatever the view.
    expect(tall.api.exportSvg()).toContain(`viewBox="0 0 ${plain.width} ${plain.height}"`);
    expect(tall.api.exportSvg()).not.toContain('diagram-zoom');

    const off = mountIn({ ...data, view: { zoom: false } }, 120);
    await off.api.ready;
    expect(off.api.zoom?.active).toBe(false);

    const on = mountIn({ ...data, view: { zoom: true } }, 5000);
    await on.api.ready;
    expect(on.api.zoom?.active).toBe(true);

    const roomy = mountIn(data, 5000);
    await roomy.api.ready;
    expect(roomy.api.zoom?.active).toBe(false);
  });
});
