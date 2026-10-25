/**
 * The browser side of a diagram canvas: read the data block, measure text in
 * this document, render, put the static SVG in the page, and expose
 * `window.diagram` for the render harness and the host:
 *
 *   window.diagram.ready       Promise of the outcome
 *   window.diagram.exportSvg() the static, self-contained SVG (a drawing
 *                              set: every page stacked, links printed as
 *                              page references)
 *   window.diagram.errors      data errors (empty when it drew)
 *   window.diagram.warnings    layout and budget notes for the author
 *   window.diagram.pages       a set's pages ({ id, title }), in order
 *   window.diagram.page        the page shown
 *   window.diagram.show(id, focus?)   show a page, highlight one element
 *   window.diagram.exportPageSvg(id?) one page's static SVG
 *
 * A drawing set (data with `pages`) shows one page at a time under a row
 * of page buttons, with Back and Overview; a connector or marker that
 * carries a link jumps to its page and highlights the element it names;
 * the arrow keys step through the pages. A link only ever switches the
 * canvas's own page: nothing is fetched, no URL is opened, and the window
 * is never navigated (the canvas sandbox's rule).
 *
 * Bad data shows its errors in the page and throws one error, which the
 * Present frame reports to its host as `{v:1, kind:'error'}`.
 */
import { render, type RenderOutcome } from './index.ts';
import { domMeasurer } from './runtime/text.ts';
// A mini app draws a template inside its own React tree instead of mounting
// a page: `render(template, data, domMeasurer(document))` returns the same
// escaped, static SVG string `mount` inserts (app-libraries.ts, app-build).
export { render, domMeasurer };
export type { RenderOutcome };
import { DATA_ID } from './canvas.ts';
import { messageOf } from './runtime/validate.ts';
import { PALETTE } from './runtime/style.ts';

export type DiagramApi = {
  ready: Promise<RenderOutcome>;
  template: string;
  errors: string[];
  warnings: string[];
  stats: Record<string, number>;
  exportSvg: () => string;
  pages: { id: string; title: string }[];
  page: string;
  show: (id: string, focus?: string) => boolean;
  exportPageSvg: (id?: string) => string;
};

type Page = NonNullable<Extract<RenderOutcome, { ok: true }>['pages']>[number];

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The attributes that name a drawn element, for a link's `focus`. */
const FOCUS_ATTRS = ['data-line', 'data-equipment', 'data-offpage', 'data-tee', 'data-more'];
const HISTORY_MAX = 50;

const SET_CSS = `
#diagram-pages{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:center;max-width:100%;margin:0 0 12px;font:12px/1.3 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
#diagram-pages button{font:inherit;color:${PALETTE.ink};background:${PALETTE.white};border:1px solid ${PALETTE.ruleSolid};border-radius:6px;padding:4px 10px;cursor:pointer;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#diagram-pages button[aria-current="page"]{background:${PALETTE.ink};color:${PALETTE.white};border-color:${PALETTE.ink}}
#diagram-pages button:disabled{opacity:.45;cursor:default}
#diagram-pages .sep{width:1px;height:18px;background:${PALETTE.ruleSolid};margin:0 4px}
#diagram [data-link]{cursor:pointer}
#diagram [data-link]:hover,#diagram [data-link]:focus-visible{opacity:.7;outline:none}
#diagram .diagram-focus{fill:none;stroke:${PALETTE.accent};stroke-width:2.5;stroke-dasharray:6 4;pointer-events:none;animation:diagram-pulse 1.2s ease-in-out 3}
@keyframes diagram-pulse{50%{stroke-opacity:.2}}
@media (prefers-reduced-motion:reduce){#diagram .diagram-focus{animation:none}}
`.trim();

/** Show a drawing set one page at a time, with its page buttons. */
function mountSet(doc: Document, target: HTMLElement, pages: Page[], api: DiagramApi): void {
  const win = doc.defaultView;
  const style = doc.createElement('style');
  style.textContent = SET_CSS;
  doc.head.appendChild(style);
  const nav = doc.createElement('nav');
  nav.id = 'diagram-pages';
  nav.setAttribute('aria-label', 'Drawing pages');
  const button = (label: string, title: string, onClick: () => void) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    nav.appendChild(b);
    return b;
  };
  const history: string[] = [];
  const back = button('Back', 'The page you came from', () => {
    const prev = history.pop();
    if (prev) show(prev, undefined, false);
  });
  const home = button('Overview', `Page 1: ${pages[0]!.title}`, () => show(pages[0]!.id));
  const sep = doc.createElement('span');
  sep.className = 'sep';
  sep.setAttribute('aria-hidden', 'true');
  nav.appendChild(sep);
  const byId = new Map(pages.map((p, i) => [p.id, { p, n: i + 1 }]));
  const pageButtons = pages.map((p, i) =>
    button(`${i + 1} ${p.title}`, `Page ${i + 1}: ${p.title}`, () => show(p.id)),
  );
  target.parentNode?.insertBefore(nav, target);

  const highlight = (focus: string) => {
    const svg = target.querySelector('svg');
    if (!svg) return;
    const esc = (v: string) => (win?.CSS?.escape ? win.CSS.escape(v) : v.replace(/["\\]/g, ''));
    const sel = FOCUS_ATTRS.map((a) => `[${a}="${esc(focus)}"]`).join(',');
    const hit = svg.querySelector(sel) as SVGGraphicsElement | null;
    if (!hit || typeof hit.getBBox !== 'function') return;
    const b = hit.getBBox();
    const r = doc.createElementNS(SVG_NS, 'rect');
    r.setAttribute('class', 'diagram-focus');
    r.setAttribute('x', String(b.x - 6));
    r.setAttribute('y', String(b.y - 6));
    r.setAttribute('width', String(b.width + 12));
    r.setAttribute('height', String(b.height + 12));
    r.setAttribute('rx', '4');
    hit.parentNode?.appendChild(r);
    // Scroll this document only (never a parent frame's): the element to
    // the middle of the canvas's own window.
    if (win) {
      const box = r.getBoundingClientRect();
      win.scrollTo({
        top: Math.max(0, win.scrollY + box.top - win.innerHeight / 2),
        left: Math.max(0, win.scrollX + box.left - win.innerWidth / 2),
      });
    }
  };

  function show(id: string, focus?: string, remember = true): boolean {
    const hit = byId.get(id);
    if (!hit) return false;
    if (remember && api.page && api.page !== id) {
      history.push(api.page);
      if (history.length > HISTORY_MAX) history.shift();
    }
    // The page SVG is the template's escaped, static output.
    target.innerHTML = hit.p.svg;
    api.page = id;
    pageButtons.forEach((b, i) => {
      if (pages[i]!.id === id) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    back.disabled = history.length === 0;
    home.disabled = hit.n === 1;
    for (const a of target.querySelectorAll('[data-link]')) {
      const to = byId.get(a.getAttribute('data-link') ?? '');
      if (!to) continue;
      a.setAttribute('tabindex', '0');
      a.setAttribute('role', 'link');
      a.setAttribute('aria-label', `Go to page ${to.n}: ${to.p.title}`);
    }
    if (focus) highlight(focus);
    else win?.scrollTo({ top: 0, left: 0 });
    return true;
  }

  const follow = (a: Element) => {
    const page = a.getAttribute('data-link');
    if (page) show(page, a.getAttribute('data-focus') ?? undefined);
  };
  target.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('[data-link]');
    if (a) follow(a);
  });
  doc.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const a = (e.target as Element | null)?.closest?.('#diagram [data-link]');
    if (a && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      follow(a);
      return;
    }
    const n = byId.get(api.page)?.n ?? 1;
    const step =
      e.key === 'ArrowRight' || e.key === 'PageDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'PageUp'
          ? -1
          : 0;
    if (step && pages[n - 1 + step]) {
      e.preventDefault();
      show(pages[n - 1 + step]!.id);
    } else if (e.key === 'Home' && n !== 1) {
      e.preventDefault();
      show(pages[0]!.id);
    }
  });
  api.pages = pages.map((p) => ({ id: p.id, title: p.title }));
  api.show = (id, focus) => show(id, focus);
  api.exportPageSvg = (id) => {
    const p = byId.get(id ?? api.page);
    if (!p) throw new Error(`diagram: no page '${String(id)}'`);
    return p.p.svg;
  };
  show(pages[0]!.id, undefined, false);
}

declare global {
  interface Window {
    diagram?: DiagramApi;
  }
}

function fail(doc: Document, errors: string[]): void {
  const box = doc.getElementById('diagram-errors');
  if (box) {
    box.textContent = `This diagram's data has ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n\n- ${errors.join('\n- ')}`;
    box.classList.add('show');
  }
}

export function mount(doc: Document = document): DiagramApi {
  let resolve!: (o: RenderOutcome) => void;
  const ready = new Promise<RenderOutcome>((r) => (resolve = r));
  const api: DiagramApi = {
    ready,
    template: '',
    errors: [],
    warnings: [],
    stats: {},
    exportSvg: () => {
      throw new Error('diagram: nothing to export, the data did not render');
    },
    pages: [],
    page: '',
    show: () => false,
    exportPageSvg: () => api.exportSvg(),
  };
  window.diagram = api;
  const run = async () => {
    let outcome: RenderOutcome;
    const block = doc.getElementById(DATA_ID);
    let data: unknown;
    try {
      data = JSON.parse(block?.textContent ?? '');
    } catch (err) {
      outcome = {
        ok: false,
        template: '',
        errors: [`data: the data block is not valid JSON (${messageOf(err)}).`],
        warnings: [],
      };
    }
    if (data !== undefined) {
      // System fonts are local, but wait for any the page declares anyway.
      if (doc.fonts?.ready) await doc.fonts.ready;
      const meta =
        doc.querySelector('meta[name="diagram:template"]')?.getAttribute('content') ?? '';
      const fromData = (data as { template?: unknown }).template;
      const template = typeof fromData === 'string' ? fromData : (meta.split('@')[0] ?? '');
      outcome = render(template, data, domMeasurer(doc));
    }
    api.template = outcome!.template;
    api.warnings = outcome!.warnings;
    if (outcome!.ok) {
      const svg = outcome!.svg;
      api.stats = outcome!.stats;
      api.exportSvg = () => svg;
      const target = doc.getElementById('diagram');
      const pages = outcome!.pages;
      // The SVG is built from escaped strings by the template (no markup
      // from the data reaches it unescaped), so it is safe to insert.
      if (target && pages && pages.length > 1) mountSet(doc, target, pages, api);
      else if (target) target.innerHTML = pages?.[0]?.svg ?? svg;
      if (pages?.length === 1) {
        api.pages = [{ id: pages[0]!.id, title: pages[0]!.title }];
        api.page = pages[0]!.id;
        api.exportPageSvg = () => pages[0]!.svg;
      }
    } else {
      api.errors = outcome!.errors;
      fail(doc, outcome!.errors);
    }
    resolve(outcome!);
    if (!outcome!.ok) {
      // Uncaught on purpose: the Present frame reports it to the host.
      setTimeout(() => {
        throw new Error(
          `diagram: ${outcome!.errors[0]}${outcome!.errors.length > 1 ? ` (and ${outcome!.errors.length - 1} more)` : ''}`,
        );
      });
    }
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => void run());
  else void run();
  return api;
}
