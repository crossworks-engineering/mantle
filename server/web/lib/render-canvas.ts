/**
 * Render a Present canvas to a PNG in the browser sidecar
 * (docs/proposals/canvas-files.md sections 7.4 and 8.2): the agent's look
 * (`present_render`, `diagram_render`) and the poster cache.
 *
 * Nothing in the render touches the network or this server's routes. The
 * page opens a made-up origin that request interception answers itself: the
 * frame document (the same builder and CSP header the frame route uses, so a
 * picture shows what the frame runs), and the vendored files the canvas may
 * load, read from this tier's public/ directory. Every other request is
 * refused and reported, so a canvas that reaches for a CDN renders without
 * it and says so. No cookie, no ticket, no render surface: the sidecar never
 * holds a credential for this. The sidecar is browserless; we connect,
 * render, and disconnect (never close).
 *
 * A timeout bounds every step, and at most two renders run at once
 * (section 7.4), so a canvas that spins a core costs one slot for its
 * timeout, not the box.
 */
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';
import { env } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { buildCanvasFrameCsp } from '@mantle/share-ui/canvas-frame-html';
import type { CanvasDiagramReport, CanvasRenderRequest, CanvasRenderResult } from '@mantle/tools';
import { canvasFrameDocument } from './canvas-frame';

/** The origin the render page believes it is on. `.invalid` never resolves:
 *  interception answers every request to it. */
export const RENDER_ORIGIN = 'https://canvas.render.invalid';

/** The public files a canvas may load, by path prefix (the frame CSP's). */
const SERVED_PREFIXES = ['/canvas-runtime/', '/share-runtime/', '/fonts/', '/Inter/'];

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** The longest edge a render's viewport may have (a fixed canvas larger than
 *  this is drawn scaled down by its own fit). */
const MAX_EDGE = 2400;
const DEFAULT_FILL = { w: 1600, h: 900 };
const NAV_TIMEOUT_MS = 20_000;
const SETTLE_DEFAULT_S = 2;
const SETTLE_MAX_S = 10;
const DIAGRAM_TIMEOUT_MS = 8_000;
/** The whole render, load to picture. A canvas that blocks its main thread
 *  can stall a step that has no timeout of its own (the screenshot); past
 *  this the page is closed and the slot freed. */
const RENDER_BUDGET_MS = 45_000;
const SLOTS = 2;

let busy = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  // `while`: a woken waiter re-checks (draw-snapshot.ts withSlot says why).
  while (busy >= SLOTS) await new Promise<void>((r) => waiting.push(r));
  busy++;
  try {
    return await fn();
  } finally {
    busy--;
    waiting.shift()?.();
  }
}

/** A served public file, or null (outside the prefixes, missing, or a path
 *  that climbs out of public/). */
async function publicFile(pathname: string): Promise<{ body: Buffer; type: string } | null> {
  if (!SERVED_PREFIXES.some((p) => pathname.startsWith(p))) return null;
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
  } catch {
    return null;
  }
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + sep)) return null;
  try {
    const body = await readFile(file);
    return { body, type: TYPES[extname(file)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

/** The viewport a canvas renders at: its design size (scaled to fit
 *  MAX_EDGE), or the asked size for a `fill` canvas. */
function viewportFor(req: CanvasRenderRequest): { width: number; height: number } {
  const size = req.canvas.meta.size;
  const base =
    size === 'fill'
      ? { w: req.width ?? DEFAULT_FILL.w, h: req.height ?? DEFAULT_FILL.h }
      : { w: size.w, h: size.h };
  const k = Math.min(1, MAX_EDGE / Math.max(base.w, base.h));
  return {
    width: Math.max(100, Math.round(base.w * k)),
    height: Math.max(100, Math.round(base.h * k)),
  };
}

/** The origin of a URL for a report: never its path or query. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'an unparseable URL';
  }
}

export async function renderCanvas(req: CanvasRenderRequest): Promise<CanvasRenderResult> {
  const endpoint = env('BROWSER_WS_ENDPOINT');
  if (!endpoint) {
    return {
      ok: false,
      error:
        'No browser sidecar on this brain (BROWSER_WS_ENDPOINT is not set), so a canvas cannot be drawn to a picture. The canvas itself is saved and runs in Present.',
    };
  }
  return withSlot(async () => {
    let browser;
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
    } catch (err) {
      return { ok: false, error: `The browser sidecar is not reachable (${errorMessage(err)}).` };
    }
    const consoleErrors: string[] = [];
    const blocked = new Set<string>();
    let page: Page | null = null;
    let budget: ReturnType<typeof setTimeout> | undefined;
    const overBudget = new Promise<CanvasRenderResult>((resolve) => {
      budget = setTimeout(
        () =>
          resolve({
            ok: false,
            error: `The canvas did not finish drawing within ${RENDER_BUDGET_MS / 1000} seconds. Something in it runs without end (a loop, a busy animation): fix that and save again.`,
          }),
        RENDER_BUDGET_MS,
      );
    });
    const work = async (): Promise<CanvasRenderResult> => {
      const html = await canvasFrameDocument(req.ownerId, req.canvas, {
        cls: req.theme === 'dark' ? 'dark' : '',
        colorTheme: null,
      });
      page = await browser.newPage();
      const view = viewportFor(req);
      await page.setViewport({ ...view, deviceScaleFactor: req.scale === 2 ? 2 : 1 });
      await page.setRequestInterception(true);
      page.on('request', (r) => {
        if (r.isInterceptResolutionHandled()) return;
        const url = r.url();
        if (url.startsWith('data:') || url.startsWith('blob:')) {
          void r.continue().catch(() => {});
          return;
        }
        void (async () => {
          let parsed: URL | null;
          try {
            parsed = new URL(url);
          } catch {
            parsed = null;
          }
          if (parsed?.origin === RENDER_ORIGIN && parsed.pathname === '/frame') {
            await r.respond({
              status: 200,
              headers: { 'content-security-policy': buildCanvasFrameCsp(RENDER_ORIGIN, []) },
              contentType: 'text/html; charset=utf-8',
              body: html,
            });
            return;
          }
          const file = parsed?.origin === RENDER_ORIGIN ? await publicFile(parsed.pathname) : null;
          if (file) {
            await r.respond({
              status: 200,
              headers: { 'access-control-allow-origin': '*' },
              contentType: file.type,
              body: file.body,
            });
            return;
          }
          blocked.add(parsed?.origin === RENDER_ORIGIN ? parsed.pathname : originOf(url));
          await r.abort('blockedbyclient');
        })().catch(() => {});
      });
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
      });
      page.on('pageerror', (err) => consoleErrors.push(errorMessage(err).slice(0, 300)));

      await page.goto(`${RENDER_ORIGIN}/frame`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
      const settle = Math.min(SETTLE_MAX_S, Math.max(0, req.atSeconds ?? SETTLE_DEFAULT_S));
      if (req.slide && req.slide > 1) {
        await page.focus('body').catch(() => {});
        for (let i = 1; i < Math.min(req.slide, 200); i++) {
          await page.keyboard.press('ArrowRight');
          await new Promise((r) => setTimeout(r, 120));
        }
      }
      await new Promise((r) => setTimeout(r, settle * 1000));

      const diagram: CanvasDiagramReport | null = await Promise.race([
        page.evaluate(async (wantSvg: boolean) => {
          type Outcome =
            | { ok: true; warnings: string[]; stats: Record<string, number> }
            | { ok: false; errors: string[]; warnings: string[] };
          const d = (
            window as unknown as {
              diagram?: { ready: Promise<Outcome>; exportSvg: () => string };
            }
          ).diagram;
          if (!d) return null;
          const o = await d.ready;
          return o.ok
            ? {
                ok: true,
                errors: [],
                warnings: o.warnings,
                stats: o.stats,
                ...(wantSvg ? { svg: d.exportSvg() } : {}),
              }
            : { ok: false, errors: o.errors, warnings: o.warnings, stats: {} };
        }, req.exportSvg === true),
        new Promise<null>((r) => setTimeout(() => r(null), DIAGRAM_TIMEOUT_MS)),
      ]);

      const png = Buffer.from(await page.screenshot({ type: 'png' }));
      return {
        ok: true,
        png,
        width: view.width,
        height: view.height,
        consoleErrors: [...new Set(consoleErrors)].slice(0, 20),
        blocked: [...blocked].slice(0, 20),
        ...(diagram ? { diagram } : {}),
      };
    };
    try {
      return await Promise.race([
        work().catch((err: unknown): CanvasRenderResult => ({
          ok: false,
          error: `The canvas could not be drawn (${errorMessage(err)}).`,
        })),
        overBudget,
      ]);
    } finally {
      clearTimeout(budget);
      // Closed whatever happened: a page left open would keep running in
      // the sidecar after we disconnect. A page whose script never yields
      // is stopped first (CDP answers that while the page is busy), or the
      // close waits on it.
      const open = page as Page | null;
      if (open) {
        await Promise.race([
          open
            .createCDPSession()
            .then((cdp) => cdp.send('Runtime.terminateExecution'))
            .catch(() => {}),
          new Promise((r) => setTimeout(r, 2_000)),
        ]);
        await Promise.race([
          open.close().catch(() => {}),
          new Promise((r) => setTimeout(r, 5_000)),
        ]);
      }
      await browser.disconnect().catch(() => {});
    }
  });
}
