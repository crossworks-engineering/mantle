/**
 * The canvas side of a drawing set (browser.ts `mount`), run against a
 * small stand-in document: the page bar, the arrow keys, a link that jumps
 * to its page and marks the element it names, Back, and a focus compared
 * as text. The stand-in parses the template's own SVG (escaped, static
 * markup) only far enough to find elements by attribute; it has no layout,
 * so sizes are made up. All tags and sheets are made up.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type DiagramApi } from './browser.ts';
import { DATA_ID } from './canvas.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Listener = (e: FakeEvent) => void;
type FakeEvent = {
  type: string;
  key?: string;
  target: El | null;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  prevented: boolean;
  preventDefault: () => void;
};

const unescape = (v: string) =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** An element and its parents, up to the root. */
function lineage(el: El): El[] {
  const out: El[] = [];
  for (let at: El | null = el; at; at = at.parentNode) out.push(at);
  return out;
}

/** An element: attributes, children, listeners; no layout. */
class El {
  attrs = new Map<string, string>();
  children: El[] = [];
  parentNode: El | null = null;
  listeners = new Map<string, Listener[]>();
  style: Record<string, string> = {};
  textContent = '';
  type = '';
  title = '';
  disabled = false;
  className = '';
  scrollLeft = 0;
  clientWidth = 600;
  offsetLeft = 0;
  offsetWidth = 80;
  constructor(public tagName: string) {}
  get id() {
    return this.attrs.get('id') ?? '';
  }
  set id(v: string) {
    this.attrs.set('id', v);
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  appendChild(c: El) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: El, before: El) {
    c.parentNode = this;
    const i = this.children.indexOf(before);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, over: Partial<FakeEvent> = {}): FakeEvent {
    const e: FakeEvent = {
      type,
      target: this,
      prevented: false,
      preventDefault() {
        e.prevented = true;
      },
      ...over,
    };
    // Bubbles to the root, as a click on an SVG element does.
    for (const at of lineage(this)) {
      for (const fn of at.listeners.get(type) ?? []) fn(e);
    }
    return e;
  }
  click() {
    return this.fire('click');
  }
  /** Descendants, depth first. */
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  /** `tag`, or a list of `[attr]`, optionally after `#id `. */
  private matcher(sel: string): (e: El) => boolean {
    const attrs = [...sel.matchAll(/\[([\w-]+)\]/g)].map((m) => m[1]!);
    if (attrs.length) return (e) => attrs.some((a) => e.attrs.has(a));
    return (e) => e.tagName === sel;
  }
  querySelectorAll(sel: string): El[] {
    return this.all().filter(this.matcher(sel));
  }
  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  closest(sel: string): El | null {
    const scope = /^#([\w-]+)\s/.exec(sel)?.[1];
    const ok = this.matcher(sel.replace(/^#[\w-]+\s+/, ''));
    for (const at of lineage(this)) {
      if (!ok(at)) continue;
      if (!scope) return at;
      for (let up = at.parentNode; up; up = up.parentNode) if (up.id === scope) return at;
      return null;
    }
    return null;
  }
  getBBox() {
    return { x: 10, y: 20, width: this.textContent.length * 7 || 40, height: 12 };
  }
  getBoundingClientRect() {
    return { top: 0, left: 0 };
  }
  /** The template's static SVG: tags and attributes, nothing else. */
  set innerHTML(html: string) {
    this.children = [];
    const stack: El[] = [this];
    for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
      const [, close, tag, rest, self] = m;
      if (close) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const el = new El(tag!);
      for (const a of rest!.matchAll(/([\w:-]+)="([^"]*)"/g)) el.attrs.set(a[1]!, unescape(a[2]!));
      stack[stack.length - 1]!.appendChild(el);
      if (!self) stack.push(el);
    }
  }
}

function fakeDocument(data: unknown) {
  const listeners = new Map<string, Listener[]>();
  const head = new El('head');
  const body = new El('body');
  const main = new El('main');
  main.id = 'diagram';
  const errors = new El('div');
  errors.id = 'diagram-errors';
  const block = new El('script');
  block.id = DATA_ID;
  block.textContent = JSON.stringify(data);
  for (const e of [main, errors, block]) body.appendChild(e);
  const doc = {
    readyState: 'complete',
    head,
    body,
    fonts: { ready: Promise.resolve() },
    defaultView: {
      scrollX: 0,
      scrollY: 0,
      innerWidth: 1200,
      innerHeight: 800,
      scrollTo: () => {},
    },
    createElement: (tag: string) => new El(tag),
    createElementNS: (_ns: string, tag: string) => new El(tag),
    getElementById: (id: string) =>
      [head, body, ...head.all(), ...body.all()].find((e) => e.id === id) ?? null,
    querySelector: () => null,
    addEventListener: (type: string, fn: Listener) =>
      listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    /** A key pressed with the focus on the page body. */
    key(key: string) {
      const e: FakeEvent = {
        type: 'keydown',
        key,
        target: body,
        prevented: false,
        preventDefault() {
          e.prevented = true;
        },
      };
      for (const fn of listeners.get('keydown') ?? []) fn(e);
      return e;
    },
  };
  return { doc, main };
}

const set = () =>
  JSON.parse(readFileSync(path.join(ROOT, 'test/pid-set.json'), 'utf8')) as Record<string, any>;

describe('a drawing set in the canvas', () => {
  let saved: unknown;
  beforeEach(() => {
    saved = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = saved;
  });

  const open = async () => {
    const { doc, main } = fakeDocument(set());
    const api: DiagramApi = mount(doc as unknown as Document);
    const outcome = await api.ready;
    expect(outcome.ok).toBe(true);
    const nav = doc.getElementById('diagram-pages')!;
    const buttons = nav.children.filter((c) => c.tagName === 'button');
    const current = () =>
      buttons.filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.textContent);
    return { doc, main, api, nav, buttons, current };
  };

  it('shows the first page under one row of page buttons', async () => {
    const { api, nav, buttons, current, doc } = await open();
    expect(api.pages.map((p) => p.id)).toEqual(['overview', 'sheet-1', 'sheet-2']);
    expect(api.page).toBe('overview');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Back',
      'Overview',
      '1 Overview',
      '2 PID-1001',
      '3 PID-1002',
    ]);
    expect(current()).toEqual(['1 Overview']);
    expect(buttons[0]!.disabled).toBe(true);
    expect(buttons[1]!.disabled).toBe(true);
    // The bar sits right above the drawing, one row that scrolls sideways.
    expect(nav.parentNode!.children.indexOf(nav) + 1).toBe(
      nav.parentNode!.children.findIndex((c) => c.id === 'diagram'),
    );
    const css = doc.head.children.map((s) => s.textContent).join('\n');
    expect(css).toMatch(/#diagram-pages\{display:flex;flex-wrap:nowrap;[^}]*overflow-x:auto;/);
    expect(css).toMatch(/#diagram-pages\{[^}]*scrollbar-width:thin/);
  });

  it('the arrow keys step through the pages, and stop at the ends', async () => {
    const { doc, api, current } = await open();
    expect(doc.key('ArrowLeft').prevented).toBe(false);
    expect(api.page).toBe('overview');
    expect(doc.key('ArrowRight').prevented).toBe(true);
    expect(api.page).toBe('sheet-1');
    doc.key('ArrowRight');
    expect(api.page).toBe('sheet-2');
    expect(current()).toEqual(['3 PID-1002']);
    expect(doc.key('ArrowRight').prevented).toBe(false);
    expect(api.page).toBe('sheet-2');
    doc.key('Home');
    expect(api.page).toBe('overview');
  });

  it('a link jumps to its page and marks the element it names; Back returns', async () => {
    const { main, api, buttons } = await open();
    const marker = main.querySelectorAll('[data-link]')[0]!;
    expect(marker.getAttribute('data-link')).toBe('sheet-1');
    expect(marker.getAttribute('role')).toBe('link');
    expect(marker.getAttribute('aria-label')).toBe('Go to page 2: PID-1001');
    // A click on a part of the marker reaches it.
    (marker.children[0] ?? marker).click();
    expect(api.page).toBe('sheet-1');
    const ring = main
      .querySelectorAll('rect')
      .find((r) => r.getAttribute('class') === 'diagram-focus');
    // The ring is drawn beside the element the link names (line L1-1).
    const named = main
      .querySelectorAll('[data-line]')
      .find((e) => e.getAttribute('data-line') === 'L1-1');
    expect(named).toBeDefined();
    expect(ring?.parentNode).toBe(named!.parentNode);
    expect(
      main.querySelectorAll('rect').filter((r) => r.getAttribute('class') === 'diagram-focus'),
    ).toHaveLength(1);
    expect(buttons[0]!.disabled).toBe(false);
    buttons[0]!.click();
    expect(api.page).toBe('overview');
  });

  it('a focus is compared as text: an id with quotes or brackets marks nothing and breaks nothing', async () => {
    const { main, api } = await open();
    for (const odd of ['L1-1"]', "x'],[data-line", 'a\nb']) {
      expect(api.show('sheet-1', odd)).toBe(true);
      expect(api.page).toBe('sheet-1');
      expect(
        main.querySelectorAll('rect').some((r) => r.getAttribute('class') === 'diagram-focus'),
      ).toBe(false);
    }
    expect(api.show('no-such-page')).toBe(false);
  });
});
