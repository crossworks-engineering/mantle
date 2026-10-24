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
import { extname, join, normalize, sep } from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { env } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { buildCanvasFrameCsp } from '@mantle/share-ui/canvas-frame-html';
import type {
  CanvasDiagramReport,
  CanvasRenderRequest,
  CanvasRenderResult,
} from '../canvas-render-bridge';
import { canvasFrameDocument, publicDir } from './frame-document';

/** The origin the render page believes it is on. `.invalid` never resolves:
 *  interception answers every request to it. */
export const RENDER_ORIGIN = 'https://canvas.render.invalid';

/** The public files a canvas may load, by path prefix (the frame CSP's). */
const SERVED_PREFIXES = ['/canvas-runtime/', '/share-runtime/', '/fonts/', '/Inter/'];

/** The brain's public directory, found once. */
let publicRoot: string | null = null;

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
/** The sidecar answers a connect at once when it is up: past this it is
 *  down or overloaded, which is reported as such, not as the canvas. */
const CONNECT_TIMEOUT_MS = 10_000;
/** The furthest slide a render steps to (an arrow key each). */
const MAX_SLIDE = 60;
const SETTLE_DEFAULT_S = 2;
const SETTLE_MAX_S = 10;
const DIAGRAM_TIMEOUT_MS = 8_000;
/** The whole render, load to picture. A canvas that blocks its main thread
 *  can stall a step that has no timeout of its own (the screenshot); past
 *  this the page is closed and the slot freed. */
const RENDER_BUDGET_MS = 45_000;
const SLOTS = 2;
/** Renders that may wait for a slot; past this a render is refused at once
 *  rather than queued behind work it cannot see the end of. */
const MAX_WAITING = 6;
/** What a render collects from the canvas: its console, its refused
 *  requests and what it says about itself are the canvas's own text, so
 *  each is capped where it is gathered, not after. */
const MAX_LINES = 50;
const MAX_LINE_CHARS = 300;
const MAX_SVG_CHARS = 3_000_000;
/** The picture's pixels, scale included (4K): past it the scale is lowered
 *  to fit, so a big canvas at 2x cannot make a 90 MB picture. */
const MAX_PIXELS = 3840 * 2160;
/** A PNG past this is taken again as a JPEG; a JPEG past it is refused. */
const MAX_IMAGE_BYTES = 6_000_000;

/** Launch flags for the sidecar's browser, per connection (browserless
 *  starts one browser per connection and takes `launch` from the URL). A
 *  render needs no network at all: every request it makes is answered or
 *  refused by interception. These close what interception does not see:
 *  no name resolves, everything else goes to a proxy that is not there
 *  (loopback included), and WebRTC may not send UDP past it. */
export const RENDER_LAUNCH_ARGS: readonly string[] = [
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--dns-prefetch-disable',
];

/** The sidecar URL with the launch flags; a bare DevTools endpoint (a local
 *  Chrome) is left as it is: that browser was started by whoever runs it. */
export function lockedEndpoint(endpoint: string): string {
  if (endpoint.includes('/devtools/browser/')) {
    log('render-canvas').warn(
      'BROWSER_WS_ENDPOINT is a bare DevTools endpoint: canvas renders run without the network lock (development only)',
    );
    return endpoint;
  }
  const url = new URL(endpoint);
  url.searchParams.set('launch', JSON.stringify({ args: RENDER_LAUNCH_ARGS }));
  return url.toString();
}

/** Run before any canvas script, in every frame the page makes (a blank
 *  iframe's window included):
 *   - no WebRTC anywhere (the frame prelude removes it from the top window
 *     only);
 *   - the built-ins the diagram probe uses, kept where the canvas cannot
 *     change them (a canvas may replace Array, String and JSON's methods);
 *   - the console capped where it is written: each message cut to a short
 *     text and only the first ones kept, so a canvas that prints without end
 *     cannot send it all back to the server;
 *   - an uncaught error reported as a short console line, not in full. */
export const RENDER_INIT = `(() => {
  const D = Object.defineProperty;
  for (const n of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCIceCandidate','RTCSessionDescription','RTCRtpSender','RTCRtpReceiver']) {
    try { D(globalThis, n, { value: undefined, configurable: false, writable: false }); } catch {}
  }
  const P = Object.freeze({
    stringify: JSON.stringify, apply: Reflect.apply, isArray: Array.isArray,
    slice: Array.prototype.slice, strSlice: String.prototype.slice, String: String,
    keys: Object.keys,
  });
  try { D(globalThis, '__mantleProbe', { value: P, configurable: false, writable: false, enumerable: false }); } catch {}
  const apply = Reflect.apply, S = String, cut = String.prototype.slice;
  let n = 0;
  const short = (v) => { try { return apply(cut, S(v), [0, ${MAX_LINE_CHARS}]); } catch { return '?'; } };
  for (const k of ['error', 'warn', 'log', 'info', 'debug', 'trace', 'dir', 'table']) {
    const orig = console[k];
    if (typeof orig !== 'function') continue;
    const fn = function (a) { if (++n > ${MAX_LINES}) return; return apply(orig, console, [short(a)]); };
    try { D(console, k, { value: fn, configurable: false, writable: false }); } catch {}
  }
  const err = console.error;
  addEventListener('error', (e) => { e.preventDefault(); err(e && (e.message || (e.error && e.error.message)) || 'an uncaught error'); }, true);
  addEventListener('unhandledrejection', (e) => { e.preventDefault(); err(e && e.reason && (e.reason.message || e.reason) || 'an unhandled rejection'); }, true);
})();`;

let busy = 0;
const waiting: Array<() => void> = [];

class RenderBusyError extends Error {}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (busy >= SLOTS && waiting.length >= MAX_WAITING) throw new RenderBusyError();
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
  publicRoot ??= publicDir();
  const file = join(publicRoot, rel);
  if (!file.startsWith(publicRoot + sep)) return null;
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

/**
 * Asks a template canvas (`window.diagram`) for its outcome and, for an
 * export, its SVG, as JavaScript source. A string, not a function: the
 * TypeScript runner rewrites a named function (`__name(...)`), and that
 * helper does not exist in the page. The canvas's own words are capped
 * here before they cross, and again on this side (cappedReport).
 */
export function diagramProbe(
  wantSvg: boolean,
  maxLines: number,
  maxChars: number,
  maxSvg: number,
): string {
  const args = JSON.stringify([wantSvg, maxLines, maxChars, maxSvg]);
  const maxTotal = maxSvg + 2 * maxLines * maxChars + 4096;
  return `(async ([wantSvg, maxLines, maxChars, maxSvg]) => {
  const P = globalThis.__mantleProbe;
  if (!P) return null;
  const d = window.diagram;
  if (!d) return null;
  const o = await d.ready;
  const str = (x) => P.apply(P.strSlice, P.String(x), [0, maxChars]);
  const lines = (v) => {
    if (!P.isArray(v)) return [];
    const head = P.apply(P.slice, v, [0, maxLines]);
    const out = [];
    for (let i = 0; i < head.length && i < maxLines; i++) out[i] = str(head[i]);
    return out;
  };
  const stats = {};
  if (o && o.ok && o.stats && typeof o.stats === 'object') {
    const ks = P.apply(P.slice, P.keys(o.stats), [0, maxLines]);
    for (let i = 0; i < ks.length && i < maxLines; i++) {
      const v = o.stats[ks[i]];
      if (typeof v === 'number') stats[P.apply(P.strSlice, P.String(ks[i]), [0, 40])] = v;
    }
  }
  let out;
  if (!o || !o.ok) {
    out = { ok: false, errors: lines(o && o.errors), warnings: lines(o && o.warnings), stats };
  } else {
    let svg;
    if (wantSvg) {
      const x = d.exportSvg();
      svg = typeof x === 'string' && x.length <= maxSvg ? x : undefined;
    }
    out = { ok: true, errors: svg === undefined && wantSvg ? ['the export is missing or too large'] : [], warnings: lines(o.warnings), stats };
    if (svg !== undefined) out.svg = svg;
  }
  const text = P.stringify(out);
  return typeof text === 'string' && text.length <= ${maxTotal} ? text : null;
})(${args})`;
}

/** What a canvas said about itself, bounded on this side: arrays of short
 *  strings, number-only stats with short keys, the SVG a capped string. */
function cappedReport(raw: unknown): CanvasDiagramReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lines = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.slice(0, MAX_LINES).map((x) => (typeof x === 'string' ? x : '').slice(0, MAX_LINE_CHARS))
      : [];
  const stats: Record<string, number> = {};
  if (r.stats && typeof r.stats === 'object') {
    for (const [k, v] of Object.entries(r.stats as Record<string, unknown>).slice(0, MAX_LINES)) {
      if (typeof v === 'number' && Number.isFinite(v)) stats[k.slice(0, 40)] = v;
    }
  }
  const svg = typeof r.svg === 'string' && r.svg.length <= MAX_SVG_CHARS ? r.svg : undefined;
  return {
    ok: r.ok === true,
    errors: lines(r.errors),
    warnings: lines(r.warnings),
    stats,
    ...(svg !== undefined ? { svg } : {}),
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
  try {
    return await withSlot(() => renderInSlot(endpoint, req));
  } catch (err) {
    if (err instanceof RenderBusyError) {
      return {
        ok: false,
        error:
          'The canvas renderer is busy with other canvases. The canvas is saved; look at it again in a minute.',
      };
    }
    throw err;
  }
}

async function renderInSlot(
  endpoint: string,
  req: CanvasRenderRequest,
): Promise<CanvasRenderResult> {
  const consoleErrors: string[] = [];
  const blocked = new Set<string>();
  const note = (list: string[], text: string) => {
    if (list.length < MAX_LINES) list.push(text.slice(0, MAX_LINE_CHARS));
  };
  let browser: Awaited<ReturnType<typeof puppeteer.connect>> | null = null;
  let page: Page | null = null;
  /** Set when the render is over (budget or done): work still in flight
   *  must not open what the cleanup has already passed. */
  let over = false;
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
    try {
      let wait: ReturnType<typeof setTimeout> | undefined;
      browser = await Promise.race([
        puppeteer.connect({ browserWSEndpoint: lockedEndpoint(endpoint) }),
        new Promise<never>((_, reject) => {
          wait = setTimeout(() => reject(new Error('connect timed out')), CONNECT_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(wait));
    } catch (err) {
      log('render-canvas').error(`sidecar connect failed: ${errorMessage(err)}`);
      return { ok: false, error: 'The browser sidecar is not reachable right now.' };
    }
    if (over) {
      // The cleanup ran while we connected: this connection is ours to drop.
      await browser.disconnect().catch(() => {});
      throw new Error('the render ran out of time before the browser answered');
    }
    page = await browser.newPage();
    if (over) {
      // The cleanup ran while the page opened: it is ours to close.
      await page.close().catch(() => {});
      throw new Error('the render ran out of time before the page opened');
    }
    await page.evaluateOnNewDocument(RENDER_INIT);
    const view = viewportFor(req);
    const want = req.scale === 2 ? 2 : 1;
    const deviceScaleFactor = Math.min(want, Math.sqrt(MAX_PIXELS / (view.width * view.height)));
    await page.setViewport({ ...view, deviceScaleFactor });
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
            headers: {
              // No workers: a worker's console is outside the page's caps.
              'content-security-policy': buildCanvasFrameCsp(RENDER_ORIGIN, [], { workers: false }),
              'x-dns-prefetch-control': 'off',
            },
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
        if (blocked.size < MAX_LINES) {
          blocked.add(
            (parsed?.origin === RENDER_ORIGIN ? parsed.pathname : originOf(url)).slice(
              0,
              MAX_LINE_CHARS,
            ),
          );
        }
        await r.abort('blockedbyclient');
      })().catch(() => {});
    });
    page.on('console', (m) => {
      if (m.type() === 'error') note(consoleErrors, m.text());
    });
    page.on('pageerror', (err) => note(consoleErrors, errorMessage(err)));

    await page.goto(`${RENDER_ORIGIN}/frame`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    const settle = Math.min(SETTLE_MAX_S, Math.max(0, req.atSeconds ?? SETTLE_DEFAULT_S));
    if (req.slide && req.slide > 1) {
      await page.focus('body').catch(() => {});
      for (let i = 1; i < Math.min(req.slide, MAX_SLIDE); i++) {
        await page.keyboard.press('ArrowRight');
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    await new Promise((r) => setTimeout(r, settle * 1000));

    const sent: unknown = await Promise.race([
      page.evaluate(diagramProbe(req.exportSvg === true, MAX_LINES, MAX_LINE_CHARS, MAX_SVG_CHARS)),
      new Promise<null>((r) => setTimeout(() => r(null), DIAGRAM_TIMEOUT_MS)),
    ]);
    // The probe answers JSON text of bounded length; read it and cap again.
    let reported: unknown = null;
    if (typeof sent === 'string') {
      try {
        reported = JSON.parse(sent);
      } catch {
        reported = null;
      }
    }
    const diagram = cappedReport(reported);

    let png = Buffer.from(await page.screenshot({ type: 'png' }));
    let mime: 'image/png' | 'image/jpeg' = 'image/png';
    if (png.length > MAX_IMAGE_BYTES) {
      png = Buffer.from(await page.screenshot({ type: 'jpeg', quality: 70 }));
      mime = 'image/jpeg';
    }
    if (png.length > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error:
          'The canvas drew a picture too large to keep (it is mostly noise, or very large). Make it simpler or smaller.',
      };
    }
    return {
      ok: true,
      png,
      mime,
      width: view.width,
      height: view.height,
      consoleErrors: [...new Set(consoleErrors)].slice(0, 20),
      blocked: [...blocked].slice(0, 20),
      ...(diagram ? { diagram } : {}),
    };
  };
  try {
    return await Promise.race([
      work().catch((err: unknown): CanvasRenderResult => {
        log('render-canvas').error(`render failed: ${errorMessage(err)}`);
        return { ok: false, error: 'The canvas could not be drawn (the browser gave up on it).' };
      }),
      overBudget,
    ]);
  } finally {
    over = true;
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
      await Promise.race([open.close().catch(() => {}), new Promise((r) => setTimeout(r, 5_000))]);
    }
    await (browser as Awaited<ReturnType<typeof puppeteer.connect>> | null)
      ?.disconnect()
      .catch(() => {});
  }
}
