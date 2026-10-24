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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, HTTPRequest, Page } from 'puppeteer-core';
import { buildApp, type AppSource } from '@mantle/app-build';
import { buildAppFrameCsp, buildAppFrameHtml } from '@mantle/share-ui/app-frame-html';
import { APP_GUIDE_LIBRARIES, guideFile } from '../builtins-canvas-library';
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

type Run = {
  msgs: { kind: string; message?: string; result?: unknown }[];
  consoleErrors: string[];
  refused: string[];
  png: Buffer;
};

describe.skipIf(!chrome || !runtimeBuilt)('mini-app library examples in a real browser', () => {
  let browser: Browser;
  let runtimeExports: Record<string, string[]>;
  let importMapJson: string;

  beforeAll(async () => {
    const manifest = JSON.parse(readFileSync(APP_MANIFEST, 'utf8')) as {
      imports: Record<string, string>;
      exports: Record<string, string[]>;
    };
    runtimeExports = manifest.exports;
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
  });

  /** Answer the made-up origin from public/, refuse and record the rest. */
  function serve(page: Page, frameHtml: string, refused: string[]) {
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

  async function run(source: AppSource, settleMs = 1500): Promise<Run> {
    const built = await buildApp(source, { runtimeExports });
    expect(built.errors, 'build errors').toEqual([]);
    expect(built.ok).toBe(true);
    const frameHtml = buildAppFrameHtml({
      bundleCode: built.code!,
      appCss: built.css ?? '',
      importMapJson,
      cls: '',
      colorTheme: null,
      viewport: true,
    });
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    const refused: string[] = [];
    try {
      await page.setViewport({ width: 980, height: 660 });
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(String(e)));
      await page.setRequestInterception(true);
      page.on('request', serve(page, frameHtml, refused));
      await page.goto(`${ORIGIN}/parent`, { waitUntil: 'load', timeout: 20_000 });
      await page.waitForFunction(
        () =>
          (window as unknown as { __msgs: { kind: string }[] }).__msgs.some(
            (m) => m.kind === 'ready' || m.kind === 'error',
          ),
        { timeout: 20_000 },
      );
      await new Promise((r) => setTimeout(r, settleMs));
      const msgs = (await page.evaluate(
        () => (window as unknown as { __msgs: unknown[] }).__msgs,
      )) as Run['msgs'];
      const frame = await page.$('#app');
      const png = Buffer.from(await frame!.screenshot({ type: 'png' }));
      return { msgs, consoleErrors, refused, png };
    } finally {
      await page.close();
    }
  }

  /** How many distinct colours a sample of the picture holds. */
  async function colours(png: Buffer): Promise<number> {
    const page = await browser.newPage();
    try {
      return await page.evaluate(
        async (src: string) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const g = c.getContext('2d')!;
          g.drawImage(img, 0, 0);
          const seen = new Set<string>();
          for (let y = 0; y < c.height; y += Math.max(1, Math.floor(c.height / 60))) {
            for (let x = 0; x < c.width; x += Math.max(1, Math.floor(c.width / 80))) {
              seen.add(Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)).join(','));
            }
          }
          return seen.size;
        },
        `data:image/png;base64,${png.toString('base64')}`,
      );
    } finally {
      await page.close();
    }
  }

  for (const lib of APP_GUIDE_LIBRARIES) {
    it(`${lib.name}: builds, runs clean in the app frame, not blank`, async () => {
      const md = readFileSync(path.join(ROOT, 'docs/canvas-libraries/app', guideFile(lib)), 'utf8');
      const r = await run({ entry: 'App.tsx', files: { 'App.tsx': appExampleOf(md) } });
      // To look at them: MANTLE_APP_SHOTS=<dir> keeps each picture.
      const shots = process.env.MANTLE_APP_SHOTS;
      if (shots) writeFileSync(path.join(shots, `${lib.name}.png`), r.png);
      expect(
        r.msgs.filter((m) => m.kind === 'error'),
        `${lib.name} reported`,
      ).toEqual([]);
      expect(
        r.msgs.some((m) => m.kind === 'ready'),
        `${lib.name} ready`,
      ).toBe(true);
      expect(r.consoleErrors, `${lib.name} console`).toEqual([]);
      expect(r.refused, `${lib.name} refused requests`).toEqual([]);
      expect(await colours(r.png), `${lib.name} is blank`).toBeGreaterThan(3);
    }, 60_000);
  }

  it('the frame still has no network and no eval, with the libraries loaded', async () => {
    const probe = [
      "import { useEffect } from 'react';",
      "import * as echarts from 'echarts';",
      'async function check() {',
      '  const out: Record<string, string> = { echarts: typeof echarts.init };',
      "  try { await fetch('/api/version'); out.fetch = 'allowed'; } catch { out.fetch = 'refused'; }",
      "  try { new Function('return 1')(); out.eval = 'allowed'; } catch { out.eval = 'refused'; }",
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
      eval: 'refused',
      cdn: 'refused',
      missing: 'refused',
    });
    // The CSP stopped the fetch, the CDN and the image before a request left
    // the frame; only the same-origin runtime path reached the server (a 404).
    expect(r.refused).toEqual([`${ORIGIN}/canvas-runtime/nope.js`]);
    expect(r.consoleErrors.join('\n')).toMatch(/Content Security Policy/);
  }, 60_000);
});
