/**
 * A render lays the canvas out at the size it asks for, in a real browser
 * through the canvas pipeline (renderCanvas): a `fill` canvas at the asked
 * window (or the default), a fixed canvas at its design size, on the first
 * render with no `slide` (the poster and the look a save returns). The
 * canvas reports its own innerWidth and innerHeight, read in its head and
 * again when the picture is taken.
 *
 * The bug this pins: browserless gives every new page its launch's default
 * viewport (800x600 unless named), racing the render's setViewport, so a
 * canvas laid out at 800x600 inside a picture of the asked size
 * (sidecar.ts lockedEndpoint). That race needs browserless: set
 * MANTLE_TEST_BROWSERLESS to its endpoint (ws://host:port?token=...) and
 * every case also runs there, several times over.
 *
 * Needs a Chrome (MANTLE_TEST_CHROME, a usual install path, or puppeteer's
 * cache) and the built canvas and share runtimes (`pnpm -C server/web
 * build`). Without either it skips, and says so loudly.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer-core';
import type { CanvasRenderRequest } from '../canvas-render-bridge';
import { findChrome } from './find-chrome';

const ROOT = path.resolve(__dirname, '../../../..');
const MANIFEST = path.join(ROOT, 'server/web/public/canvas-runtime/manifest.json');
const SHARE_CSS = path.join(ROOT, 'server/web/public/share-runtime/styles.css');
const OWNER = '00000000-0000-4000-8000-000000000000';
const BROWSERLESS = process.env.MANTLE_TEST_BROWSERLESS;
/** Renders per case against browserless: on the dev box the race lost one
 *  render in six to four in ten. */
const BROWSERLESS_ROUNDS = 5;

const chrome = findChrome(process.env.MANTLE_TEST_CHROME);
const runtimeBuilt = existsSync(MANIFEST) && existsSync(SHARE_CSS);
if (!chrome || !runtimeBuilt) {
  const bar = '='.repeat(72);
  console.warn(
    [
      bar,
      `CANVAS VIEWPORT RENDER SKIPPED: ${!chrome ? 'no Chrome found (set MANTLE_TEST_CHROME)' : 'the canvas and share runtimes are not built (pnpm -C server/web build)'}.`,
      'The size a canvas lays out at in a render was not tried in a browser.',
      bar,
    ].join('\n'),
  );
}

/** A canvas that reports the window it lays out in: in its head (before
 *  anything else of it runs) and when the render reads it. A stylesheet
 *  from the runtime, as a reveal.js deck loads one. */
const probe = (size: string) =>
  [
    '<!doctype html><html><head><title>Window probe</title>',
    `<meta name="canvas:size" content="${size}">`,
    '<script>window.__head = [innerWidth, innerHeight];</script>',
    '<link rel="stylesheet" href="/canvas-runtime/reveal/reveal.css">',
    '</head><body><p>probe</p><script>',
    'window.diagram = { ready: Promise.resolve({ ok: true, warnings: [], stats: {',
    '  headW: window.__head[0], headH: window.__head[1],',
    '  get w() { return innerWidth; }, get h() { return innerHeight; },',
    '} }) };',
    '</script></body></html>',
  ].join('\n');

const CASES: ReadonlyArray<{
  name: string;
  size: string;
  ask?: Partial<CanvasRenderRequest>;
  w: number;
  h: number;
}> = [
  { name: 'a fill canvas at the default window', size: 'fill', w: 1600, h: 900 },
  {
    name: 'a fill canvas at the asked window',
    size: 'fill',
    ask: { width: 1280, height: 720 },
    w: 1280,
    h: 720,
  },
  { name: 'a fixed canvas at its design size', size: '1920x1080', w: 1920, h: 1080 },
];

describe.skipIf(!chrome || !runtimeBuilt)('the window a canvas lays out in', () => {
  let browser: Browser;
  let render: typeof import('./sidecar').renderCanvas;
  let readCanvas: typeof import('@mantle/content/presents').readCanvas;
  let local = '';

  beforeAll(async () => {
    // No database here: the owner's fonts fall back to the defaults.
    process.env.DATABASE_URL ??= 'postgres://none:none@127.0.0.1:1/none';
    const puppeteer = (await import('puppeteer-core')).default;
    const sidecar = await import('./sidecar');
    browser = await puppeteer.launch({
      executablePath: chrome!,
      headless: true,
      args: [
        ...sidecar.RENDER_LAUNCH_ARGS,
        '--no-first-run',
        '--use-angle=swiftshader',
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ],
    });
    local = browser.wsEndpoint();
    render = sidecar.renderCanvas;
    ({ readCanvas } = await import('@mantle/content/presents'));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const endpoints = (): Array<[string, string, number]> => [
    ['a local Chrome', local, 1],
    ...(BROWSERLESS
      ? [['browserless', BROWSERLESS, BROWSERLESS_ROUNDS] as [string, string, number]]
      : []),
  ];

  for (const c of CASES) {
    it(`${c.name}, first render with no slide`, async () => {
      for (const [where, endpoint, rounds] of endpoints()) {
        process.env.BROWSER_WS_ENDPOINT = endpoint;
        const source = probe(c.size);
        for (let i = 0; i < rounds; i++) {
          const r = await render({
            ownerId: OWNER,
            canvas: { source, css: '', meta: readCanvas(source).meta },
            atSeconds: 0,
            ...c.ask,
          });
          expect(r.ok, r.ok ? '' : r.error).toBe(true);
          if (!r.ok) return;
          expect([r.width, r.height], `${where}: the picture`).toEqual([c.w, c.h]);
          expect(r.diagram?.stats, `${where}, render ${i + 1}: the window`).toEqual({
            headW: c.w,
            headH: c.h,
            w: c.w,
            h: c.h,
          });
        }
      }
    }, 120_000);
  }
});
