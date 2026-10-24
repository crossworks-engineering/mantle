/**
 * Every canvas_library guide's example canvas, rendered in a real browser
 * through the canvas pipeline (renderCanvas: the frame document, the CSP,
 * the vendored runtime, the sidecar's launch flags): no console error, no
 * refused request, and a picture that is not blank. A library upgrade that
 * breaks an example fails here.
 *
 * Needs a Chrome (MANTLE_TEST_CHROME, a usual install path, or puppeteer's
 * cache) and the built canvas and share runtimes (server/web/public/
 * canvas-runtime and share-runtime, made by `pnpm -C server/web build`). Without either it skips,
 * and says so loudly, as the A8 matrix does without a database.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer-core';
import { CANVAS_LIBRARIES, guideFile } from '../builtins-canvas-library';
import { findChrome } from './find-chrome';

const ROOT = path.resolve(__dirname, '../../../..');
const MANIFEST = path.join(ROOT, 'server/web/public/canvas-runtime/manifest.json');
/** The frame also loads the share runtime's styles (the theme, KaTeX's CSS). */
const SHARE_CSS = path.join(ROOT, 'server/web/public/share-runtime/styles.css');

const chrome = findChrome(process.env.MANTLE_TEST_CHROME);
const runtimeBuilt = existsSync(MANIFEST) && existsSync(SHARE_CSS);
if (!chrome || !runtimeBuilt) {
  const bar = '='.repeat(72);
  console.warn(
    [
      bar,
      `CANVAS LIBRARY EXAMPLES SKIPPED: ${!chrome ? 'no Chrome found (set MANTLE_TEST_CHROME)' : 'the canvas and share runtimes are not built (pnpm -C server/web build)'}.`,
      'The canvas_library guides’ examples were not rendered in a browser.',
      bar,
    ].join('\n'),
  );
}

/** The example canvas of a guide. */
function exampleOf(md: string): string {
  const m = /## Example\n+```html\n([\s\S]*?)\n```/.exec(md);
  if (!m) throw new Error('no ## Example html block');
  return m[1]!;
}

describe.skipIf(!chrome || !runtimeBuilt)('canvas_library examples in a real browser', () => {
  let browser: Browser;
  let render: typeof import('./sidecar').renderCanvas;
  let readCanvas: typeof import('@mantle/content/presents').readCanvas;
  let buildCanvasCss: typeof import('@mantle/app-build').buildCanvasCss;

  beforeAll(async () => {
    // No database here: the owner's fonts fall back to the defaults.
    process.env.DATABASE_URL ??= 'postgres://none:none@127.0.0.1:1/none';
    const puppeteer = (await import('puppeteer-core')).default;
    const sidecar = await import('./sidecar');
    browser = await puppeteer.launch({
      executablePath: chrome!,
      headless: true,
      // The flags a production render runs with (sidecar.ts). Ubuntu's
      // AppArmor refuses Chrome's sandbox to a plain user; the pages here
      // are our own guide examples.
      args: [
        ...sidecar.RENDER_LAUNCH_ARGS,
        '--no-first-run',
        '--use-angle=swiftshader',
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ],
    });
    process.env.BROWSER_WS_ENDPOINT = browser.wsEndpoint();
    render = sidecar.renderCanvas;
    ({ readCanvas } = await import('@mantle/content/presents'));
    ({ buildCanvasCss } = await import('@mantle/app-build'));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** How many distinct colours a sample of the picture holds. */
  async function colours(png: Buffer, mime: string): Promise<number> {
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
        `data:${mime};base64,${png.toString('base64')}`,
      );
    } finally {
      await page.close();
    }
  }

  it('a render starts no worker (the re-audit R2): the page refuses it', async () => {
    const source = [
      '<!doctype html><html><head><title>Worker</title>',
      '<meta name="canvas:size" content="400x200"></head>',
      '<body><p id="o">waiting</p><script>',
      'var o = document.getElementById("o");',
      'try {',
      '  var w = new Worker(URL.createObjectURL(new Blob(["for(;;){console.error(\'x\'.repeat(1e6))}"])));',
      '  w.onerror = function () { o.textContent = "refused"; };',
      '  o.textContent = "started";',
      '} catch (e) { o.textContent = "refused"; }',
      '</script></body></html>',
    ].join('\n');
    const r = await render({
      ownerId: '00000000-0000-4000-8000-000000000000',
      canvas: { source, css: '', meta: readCanvas(source).meta },
      atSeconds: 1,
    });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.consoleErrors.join('\n')).toMatch(/worker/i);
    expect(r.consoleErrors.join('').length).toBeLessThan(5000);
  }, 60_000);

  for (const lib of CANVAS_LIBRARIES) {
    it(`${lib.name}: renders clean and not blank`, async () => {
      const md = readFileSync(path.join(ROOT, 'docs/canvas-libraries', guideFile(lib)), 'utf8');
      const source = exampleOf(md);
      const css = await buildCanvasCss(source).catch(() => '');
      const r = await render({
        ownerId: '00000000-0000-4000-8000-000000000000',
        canvas: { source, css, meta: readCanvas(source).meta },
        atSeconds: 3,
        ...(lib.name === 'reveal.js' ? { slide: 2 } : {}),
      });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      if (!r.ok) return;
      expect(r.consoleErrors, `${lib.name} console`).toEqual([]);
      expect(r.blocked, `${lib.name} blocked`).toEqual([]);
      expect(await colours(r.png, r.mime), `${lib.name} is blank`).toBeGreaterThan(3);
    }, 60_000);
  }
});
