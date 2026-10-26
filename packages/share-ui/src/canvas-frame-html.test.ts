import { runInContext, runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  buildCanvasEmbedCsp,
  buildCanvasFrameCsp,
  buildCanvasFrameHtml,
} from './canvas-frame-html';

const ORIGIN = 'https://brain.example.test';

describe('buildCanvasFrameCsp', () => {
  const csp = buildCanvasFrameCsp(ORIGIN, ['https://app.example.test']);
  const directives = new Map(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values.join(' ')] as const;
    }),
  );

  it('sandboxes the document and closes every network door', () => {
    expect(directives.get('sandbox')).toBe('allow-scripts');
    expect(directives.get('default-src')).toBe("'none'");
    expect(directives.get('connect-src')).toBe("'none'");
    expect(directives.get('frame-src')).toBe("'none'");
    expect(directives.get('form-action')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
  });

  it('loads script only inline and from the vendored runtime', () => {
    expect(directives.get('script-src')).toBe(
      `'unsafe-inline' 'unsafe-eval' ${ORIGIN}/canvas-runtime/`,
    );
  });

  it('never lists the brain origin for images or media: no GET at our own API', () => {
    expect(directives.get('img-src')).toBe('data: blob:');
    expect(directives.get('media-src')).toBe('data: blob:');
  });

  it('is framed only by the brain and the named owner UI origins', () => {
    expect(directives.get('frame-ancestors')).toBe(`${ORIGIN} https://app.example.test`);
  });
});

describe('buildCanvasFrameHtml', () => {
  const base = {
    source: '<!DOCTYPE html><html><head><title>T</title></head><body>hi</body></html>',
    css: '.p-6{padding:1.5rem}',
    importMapJson: '{"imports":{"d3":"/canvas-runtime/d3-AAAAAAAA.js"}}',
    cls: 'dark',
    colorTheme: 'ocean',
    size: { w: 1600, h: 900 } as const,
    theme: 'follow' as const,
    fontCss: '@font-face{font-family:"X"}',
  };

  it('puts the import map and prelude before the canvas, with one doctype', () => {
    const html = buildCanvasFrameHtml(base);
    expect(html.startsWith('<!doctype html>\n')).toBe(true);
    expect(html.match(/<!doctype/gi)).toHaveLength(1);
    expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf('<html>'));
    expect(html).toContain('/canvas-runtime/d3-AAAAAAAA.js');
    expect(html).toContain('.p-6{padding:1.5rem}');
    expect(html).toContain('width:1600px!important');
  });

  it('bakes the theme in as JSON a value cannot break out of', () => {
    const html = buildCanvasFrameHtml({ ...base, cls: '</script><script>alert(1)</script>' });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it('a fixed-theme canvas ignores the host theme', () => {
    const html = buildCanvasFrameHtml({ ...base, theme: 'fixed' });
    expect(html).toContain('"cls":""');
    expect(html).toContain('"ct":null');
    expect(html).toContain('"follow":false');
  });

  it('a fill canvas gets the whole viewport, no letterbox', () => {
    const html = buildCanvasFrameHtml({ ...base, size: 'fill' });
    expect(html).not.toContain('--canvas-scale,1');
    expect(html).toContain('"size":null');
  });

  it('keeps CSS from closing its style tag', () => {
    const html = buildCanvasFrameHtml({ ...base, css: '.a{content:"</style><script>"}' });
    expect(html).not.toContain('</style><script>');
  });
});

describe('stripLeadingDoctype', () => {
  it('drops a leading BOM and doctype, keeping comments before it', async () => {
    const { stripLeadingDoctype } = await import('./canvas-frame-html');
    expect(stripLeadingDoctype('﻿<!DOCTYPE html><html>')).toBe('<html>');
    expect(stripLeadingDoctype('<!-- a --> <!doctype html><html>')).toBe('<!-- a --> <html>');
    expect(stripLeadingDoctype('<html><!doctype html>')).toBe('<html><!doctype html>');
  });

  it('is linear: many comments and no doctype take no time (the audit ReDoS)', async () => {
    const { stripLeadingDoctype } = await import('./canvas-frame-html');
    const evil = '<!--a-->'.repeat(50_000) + '<html>';
    const t = performance.now();
    expect(stripLeadingDoctype(evil)).toBe(evil);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe('the prelude', () => {
  it('takes WebRTC away before any canvas script runs', () => {
    const html = buildCanvasFrameHtml({
      source: '<html><body><script>new RTCPeerConnection()</script></body></html>',
      css: '',
      importMapJson: '{"imports":{}}',
      cls: '',
      colorTheme: null,
      size: 'fill',
      theme: 'follow',
      fontCss: '',
    });
    expect(html.indexOf("'RTCPeerConnection'")).toBeGreaterThan(0);
    expect(html.indexOf("'RTCPeerConnection'")).toBeLessThan(html.indexOf('new RTCPeerConnection'));
  });

  it('holds the nonce in its closure, posts it with ready, and removes its own script', () => {
    const html = buildCanvasFrameHtml({
      source: '<html><body>x</body></html>',
      css: '',
      importMapJson: '{"imports":{}}',
      cls: '',
      colorTheme: null,
      size: 'fill',
      theme: 'follow',
      fontCss: '',
      nonce: 'abc123',
    });
    const prelude = html.slice(0, html.indexOf('<html>'));
    expect(prelude).toContain('"n":"abc123"');
    expect(prelude).toContain('document.currentScript');
    expect(prelude).toContain("kind:'ready',n:nonce");
    // The canvas's own text never holds it.
    expect(html.slice(html.indexOf('<html>'))).not.toContain('abc123');
  });

  it('a canvas that replaces window.parent cannot obtain the nonce (the re-audit R1)', () => {
    const html = buildCanvasFrameHtml({
      source: '<html><body>x</body></html>',
      css: '',
      importMapJson: '{"imports":{}}',
      cls: '',
      colorTheme: null,
      size: 'fill',
      theme: 'follow',
      fontCss: '',
      nonce: 'secret-nonce',
    });
    const prelude = /<script>(\(function\(\)\{[\s\S]*?\}\)\(\);)<\/script>/.exec(html)![1]!;
    // A window as far as the prelude reads one: the real parent another
    // origin's, its postMessage out of the canvas's reach.
    const toParent: unknown[] = [];
    const stolen: unknown[] = [];
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    const el = {
      className: '',
      setAttribute() {},
      removeAttribute() {},
      style: { setProperty() {} },
    };
    const win: Record<string, unknown> = {
      parent: Object.freeze({ postMessage: (m: unknown) => toParent.push(m) }),
      addEventListener: (k: string, f: (e: unknown) => void) => (handlers[k] ??= []).push(f),
      innerWidth: 800,
      innerHeight: 600,
    };
    const document = { currentScript: null, documentElement: el };
    const ctx = { window: win, document, Object, String, Math };
    runInNewContext(prelude, ctx);
    // The canvas runs after the prelude: it swaps the parent for its own.
    runInNewContext(
      'window.parent = { postMessage: function (m) { stolen.push(m); } };',
      Object.assign(ctx, { stolen }),
    );
    for (const f of handlers.load ?? []) f({});
    for (const f of handlers.error ?? []) f({ message: 'boom' });
    expect(stolen).toEqual([]);
    expect(toParent).toEqual([
      { v: 1, kind: 'ready', n: 'secret-nonce' },
      { v: 1, kind: 'error', message: 'boom' },
    ]);
    // A theme message from the canvas's fake parent is not the parent's.
    const fake = win.parent;
    for (const f of handlers.message ?? [])
      f({ source: fake, data: { v: 1, kind: 'theme', cls: 'x' } });
    expect(el.className).toBe('');
  });
});

describe('the frame prelude: mantle.data (DWG phase 7a)', () => {
  /** The prelude run in a stand-in window; `nonce` '' is a render. */
  function frame(nonce: string, canvas?: string) {
    const html = buildCanvasFrameHtml({
      source: '<html><body>x</body></html>',
      css: '',
      importMapJson: '{"imports":{}}',
      cls: '',
      colorTheme: null,
      size: 'fill',
      theme: 'follow',
      fontCss: '',
      nonce,
    });
    const prelude = /<script>(\(function\(\)\{[\s\S]*?\}\)\(\);)<\/script>/.exec(html)![1]!;
    const toParent: Record<string, unknown>[] = [];
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    const options: Record<string, unknown[]> = {};
    const parent = Object.freeze({
      postMessage: (m: Record<string, unknown>) => toParent.push(m),
    });
    const win: Record<string, unknown> = {
      parent,
      addEventListener: (k: string, f: (e: unknown) => void, o?: unknown) => {
        (handlers[k] ??= []).push(f);
        (options[k] ??= []).push(o);
      },
      innerWidth: 800,
      innerHeight: 600,
    };
    const el = {
      className: '',
      setAttribute() {},
      removeAttribute() {},
      style: { setProperty() {} },
    };
    const ctx = {
      window: win,
      document: { currentScript: null, documentElement: el },
      Object,
      String,
      Math,
      JSON,
      Promise,
      Error,
      TypeError,
      setTimeout,
      clearTimeout,
    };
    runInNewContext(prelude, ctx);
    // What a canvas runs after the prelude, in the same realm.
    if (canvas) runInContext(canvas, ctx);
    const api = (win.mantle as { data: Record<string, (...a: unknown[]) => Promise<unknown>> })
      .data;
    const load = () => {
      for (const f of handlers.load ?? []) f({});
    };
    const reply = (source: unknown, data: unknown) => {
      for (const f of handlers.message ?? []) f({ source, data });
    };
    const pagehide = (persisted = false) => {
      for (const f of handlers.pagehide ?? []) f({ persisted });
    };
    return { api, toParent, load, reply, parent, pagehide, options, ctx };
  }

  it('holds every call until ready has gone, and names no canvas and no login', async () => {
    const f = frame('n1');
    const got = f.api.get!('marks');
    const saved = f.api.set!('marks', { a: [1, 2] }, { bucket: 'mine' });
    expect(f.toParent).toEqual([]);
    f.load();
    expect(f.toParent[0]).toEqual({ v: 1, kind: 'ready', n: 'n1' });
    const calls = f.toParent.slice(1);
    expect(calls).toEqual([
      {
        v: 1,
        kind: 'data',
        n: 'n1',
        id: 1,
        op: 'get',
        bucket: 'shared',
        key: 'marks',
        json: undefined,
        everyone: undefined,
        by: undefined,
      },
      {
        v: 1,
        kind: 'data',
        n: 'n1',
        id: 2,
        op: 'set',
        bucket: 'mine',
        key: 'marks',
        json: '{"a":[1,2]}',
        everyone: undefined,
        by: undefined,
      },
    ]);
    for (const c of calls) {
      expect(Object.keys(c).sort()).toEqual([
        'bucket',
        'by',
        'everyone',
        'id',
        'json',
        'key',
        'kind',
        'n',
        'op',
        'v',
      ]);
    }
    // Only the parent answers: a reply from anyone else is not taken.
    f.reply(
      { postMessage() {} },
      { v: 1, kind: 'data-reply', id: 1, ok: true, result: { value: 'forged' } },
    );
    f.reply(f.parent, {
      v: 1,
      kind: 'data-reply',
      id: 1,
      ok: true,
      result: { key: 'marks', value: 7 },
    });
    f.reply(f.parent, { v: 1, kind: 'data-reply', id: 2, ok: false, error: 'no right' });
    await expect(got).resolves.toBe(7);
    await expect(saved).rejects.toThrow('no right');
  });

  it('sends a moderation delete and a clear, each with the nonce', async () => {
    const f = frame('n3');
    f.load();
    const by = '00000000-0000-4000-8000-000000000001';
    const del = f.api.delete!('vote', { bucket: 'mine', by });
    const clr = f.api.clear!();
    const calls = f.toParent.filter((m) => m.kind === 'data');
    expect(calls).toMatchObject([
      { n: 'n3', op: 'delete', bucket: 'mine', key: 'vote', by },
      { n: 'n3', op: 'clear' },
    ]);
    f.reply(f.parent, { v: 1, kind: 'data-reply', id: 1, ok: true, result: { deleted: true } });
    f.reply(f.parent, { v: 1, kind: 'data-reply', id: 2, ok: true, result: { removed: 4 } });
    await expect(del).resolves.toBe(true);
    await expect(clr).resolves.toBe(4);
  });

  it('says leaving, with the nonce, as the document unloads', () => {
    const f = frame('n4');
    f.load();
    f.pagehide();
    expect(f.toParent.at(-1)).toEqual({ v: 1, kind: 'leaving', n: 'n4' });
    // A render (no nonce) says nothing.
    const r = frame('');
    r.load();
    r.pagehide();
    expect(r.toParent.filter((m) => m.kind === 'leaving')).toEqual([]);
  });

  it('says nothing when the page goes into the back-forward cache (persisted)', () => {
    const f = frame('n5');
    f.load();
    f.pagehide(true);
    expect(f.toParent.filter((m) => m.kind === 'leaving')).toEqual([]);
    f.pagehide(false);
    expect(f.toParent.filter((m) => m.kind === 'leaving')).toEqual([
      { v: 1, kind: 'leaving', n: 'n5' },
    ]);
  });

  it('takes pagehide in the capture phase, registered before the canvas runs', () => {
    const f = frame('n6');
    expect(f.options.pagehide).toEqual([{ capture: true }]);
  });

  it('keeps the nonce out of a held call: a canvas that patched push or an index setter reads none', async () => {
    const f = frame(
      'n7',
      `globalThis.seen = '';
       globalThis.hits = 0;
       const push = Array.prototype.push;
       Array.prototype.push = function (...a) { hits++; seen += JSON.stringify(a); return push.apply(this, a); };
       for (const i of ['0', '1']) {
         Object.defineProperty(Array.prototype, i, {
           configurable: true,
           set(v) {
             hits++;
             seen += JSON.stringify(v);
             Object.defineProperty(this, i, { value: v, writable: true, enumerable: true, configurable: true });
           },
         });
       }`,
    );
    const got = f.api.get!('marks');
    const saved = f.api.set!('marks', 1, { bucket: 'mine' });
    f.load();
    // The canvas saw both held calls go by, and no nonce in either.
    expect(runInContext('hits', f.ctx)).toBeGreaterThan(0);
    const seen = runInContext('seen', f.ctx) as string;
    expect(seen).toContain('marks');
    expect(seen).not.toContain('n7');
    // The parent still gets both calls, each with the nonce.
    expect(f.toParent.filter((m) => m.kind === 'data')).toMatchObject([
      { n: 'n7', id: 1, op: 'get', key: 'marks' },
      { n: 'n7', id: 2, op: 'set', bucket: 'mine', json: '1' },
    ]);
    f.reply(f.parent, { v: 1, kind: 'data-reply', id: 1, ok: true, result: { value: 3 } });
    f.reply(f.parent, { v: 1, kind: 'data-reply', id: 2, ok: true, result: {} });
    await expect(got).resolves.toBe(3);
    await expect(saved).resolves.toBeUndefined();
  });

  it('refuses a value that is not JSON without sending it', async () => {
    const f = frame('n2');
    f.load();
    await expect(f.api.set!('k', () => 1)).rejects.toThrow('JSON');
    await expect(f.api.set!('k', undefined)).rejects.toThrow('JSON');
    expect(f.toParent.filter((m) => m.kind === 'data')).toEqual([]);
  });

  it('in a render (no parent proof) reads answer empty and writes refuse, sending nothing', async () => {
    const f = frame('');
    f.load();
    await expect(f.api.get!('k')).resolves.toBeUndefined();
    await expect(f.api.list!()).resolves.toEqual([]);
    await expect(f.api.info!()).resolves.toMatchObject({ canWriteShared: false, readOnly: true });
    await expect(f.api.set!('k', 1)).rejects.toThrow('picture');
    await expect(f.api.clear!()).rejects.toThrow('picture');
    expect(f.toParent.filter((m) => m.kind === 'data')).toEqual([]);
  });
});

describe('buildCanvasEmbedCsp', () => {
  it('requires no network of whatever loads in the frame, and names only what an embedder may', () => {
    const csp = buildCanvasEmbedCsp('https://brain.example');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain('https://brain.example/canvas-runtime/');
    expect(csp).not.toContain('sandbox');
    expect(csp).not.toContain('frame-ancestors');
  });
});
