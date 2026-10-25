/**
 * present_render's `slide` on a drawing set, in a real browser through the
 * canvas pipeline (renderCanvas): the render steps a set's pages with the
 * arrow keys, and a set listens for them only once it is mounted (after
 * its fonts are ready). The render waits for that, so `slide: n` draws
 * page n, however late the set mounts.
 *
 * Needs a Chrome (MANTLE_TEST_CHROME, a usual install path, or puppeteer's
 * cache) and the built canvas and share runtimes (`pnpm -C server/web
 * build`). Without either it skips, and says so loudly.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer-core';
import { buildCanvas } from '@mantle/diagram-templates';
import { findChrome } from './find-chrome';

const ROOT = path.resolve(__dirname, '../../../..');
const MANIFEST = path.join(ROOT, 'server/web/public/canvas-runtime/manifest.json');
const SHARE_CSS = path.join(ROOT, 'server/web/public/share-runtime/styles.css');
const OWNER = '00000000-0000-4000-8000-000000000000';

const chrome = findChrome(process.env.MANTLE_TEST_CHROME);
const runtimeBuilt = existsSync(MANIFEST) && existsSync(SHARE_CSS);
if (!chrome || !runtimeBuilt) {
  const bar = '='.repeat(72);
  console.warn(
    [
      bar,
      `DIAGRAM SET SLIDE RENDER SKIPPED: ${!chrome ? 'no Chrome found (set MANTLE_TEST_CHROME)' : 'the canvas and share runtimes are not built (pnpm -C server/web build)'}.`,
      "present_render's slide on a drawing set was not tried in a browser.",
      bar,
    ].join('\n'),
  );
}

/** A stand-in set: it mounts `delay` ms after load, and only then listens
 *  for the arrow keys (as the pid canvas does after its fonts are ready). */
const lateSet = (delay: number) =>
  [
    '<!doctype html><html><head><title>Late set</title>',
    '<meta name="canvas:size" content="400x200"></head>',
    '<body><p id="o">page p1</p><script>',
    'var pages = ["p1", "p2", "p3", "p4"];',
    'var d = { page: "p1" };',
    'd.ready = new Promise(function (done) {',
    '  setTimeout(function () {',
    '    document.addEventListener("keydown", function (e) {',
    '      if (e.key !== "ArrowRight") return;',
    '      var n = pages.indexOf(d.page);',
    '      if (pages[n + 1]) d.page = pages[n + 1];',
    '      document.getElementById("o").textContent = "page " + d.page;',
    '    });',
    '    done({ ok: true, template: "pid", warnings: [], stats: {} });',
    `  }, ${delay});`,
    '});',
    'window.diagram = d;',
    '</script></body></html>',
  ].join('\n');

describe.skipIf(!chrome || !runtimeBuilt)('a drawing set drawn at a slide', () => {
  let browser: Browser;
  let render: typeof import('./sidecar').renderCanvas;
  let readCanvas: typeof import('@mantle/content/presents').readCanvas;

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
    process.env.BROWSER_WS_ENDPOINT = browser.wsEndpoint();
    render = sidecar.renderCanvas;
    ({ readCanvas } = await import('@mantle/content/presents'));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('waits for a set that mounts late: slide 3 is page 3', async () => {
    const source = lateSet(1500);
    const r = await render({
      ownerId: OWNER,
      canvas: { source, css: '', meta: readCanvas(source).meta },
      atSeconds: 0,
      slide: 3,
    });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.diagram?.page).toBe('p3');
  }, 60_000);

  it('the pid set canvas: slide n draws page n', async () => {
    const data = JSON.parse(
      readFileSync(path.join(ROOT, 'packages/diagram-templates/test/pid-set.json'), 'utf8'),
    ) as { pages: { id: string }[] };
    const source = buildCanvas({ template: 'pid', data, mode: 'import' });
    for (const n of [1, 3]) {
      const r = await render({
        ownerId: OWNER,
        canvas: { source, css: '', meta: readCanvas(source).meta },
        atSeconds: 0,
        slide: n,
      });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      if (!r.ok) return;
      expect(r.consoleErrors).toEqual([]);
      expect(r.diagram?.ok).toBe(true);
      expect(r.diagram?.page, `slide ${n}`).toBe(data.pages[n - 1]!.id);
    }
  }, 60_000);
});
