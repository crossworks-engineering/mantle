/**
 * Draw a mini app to a picture in the browser sidecar (`app_render`), as
 * canvas-render/sidecar.ts draws a canvas, and with its parts: the slot pool
 * (at most two renders at once, a canvas and an app together), the launch
 * flags that leave the browser no network, RENDER_INIT in every frame, the
 * timeouts and the clean-up.
 *
 * Nothing touches this server's routes. The page opens a made-up origin and
 * request interception answers every request itself:
 *  - `/host`: the host page (host-page.ts), one sandboxed iframe around the
 *    app, as the client's app sandbox;
 *  - `/frame`: the app's frame document, built in this process
 *    (frame-document.ts) with the frame route's CSP;
 *  - the runtime files the frame may load, read from public/;
 *  - `POST /host-call` from the host page only: one bridge request, answered
 *    by the request's `hostCall` (host-calls.ts answerRenderHostCall, the one
 *    door to data; a picture never writes).
 * Every other request is refused and reported. No cookie, no ticket.
 *
 * When: once the app says it is ready (its first paint; ready.hold waits
 * for ready.release) and no bridge call has been in flight for a moment,
 * then `atSeconds`. An app that never says so is drawn after READY_MAX_MS,
 * and the result says it was not ready.
 */
import { randomBytes } from 'node:crypto';
import type { Page } from 'puppeteer-core';
import { env } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import type { RenderViewport } from '../browserless';
import type { AppRenderRequest, AppRenderResult, AppRenderHostAnswer } from '../app-render-bridge';
import {
  MAX_IMAGE_BYTES,
  MAX_LINES,
  MAX_LINE_CHARS,
  MAX_PIXELS,
  NAV_TIMEOUT_MS,
  RENDER_INIT,
  RenderBusyError,
  closeRender,
  connectRender,
  originOf,
  publicFile,
  raceTimeout,
  withSlot,
} from '../canvas-render/sidecar';
import { appFrameDocument } from './frame-document';
import { HOST_CALL_MAX_CHARS, hostPageCsp, hostPageHtml } from './host-page';
import { RENDER_ANSWER_MAX_CHARS, renderRefusal } from './host-calls';

/** The origin the render page believes it is on (`.invalid` never resolves). */
export const APP_RENDER_ORIGIN = 'https://app.render.invalid';

/** The runtime files an app frame may load, by path prefix (its CSP's); the
 *  /canvas-runtime/ library files are served by exact name. */
const SERVED_PREFIXES = ['/app-runtime/', '/share-runtime/', '/fonts/', '/Inter/'];

/** The whole render, load to picture: room for every step's own cap
 *  (connect 10 s, load 20 s, ready 10 s, at_seconds 10 s, the picture). */
export const APP_RENDER_BUDGET_MS = 60_000;
/** How long an app has to say it is ready. */
export const READY_MAX_MS = 10_000;
/** How long no bridge call may be in flight before the app counts as
 *  settled. */
const QUIET_MS = 300;
const POLL_MS = 100;
/** The most bridge calls one render answers; past it each is refused. */
export const MAX_HOST_CALLS = 200;
const AT_SECONDS_MAX = 10;

type RenderState = {
  ready: boolean;
  hold: boolean;
  released: boolean;
  errors: string[];
  inflight: number;
  last: number;
};

/** Read the host page's notes (our page: the app cannot reach it). */
const READ_STATE = `(() => { const s = window.__mantleAppRender; return s ? JSON.stringify({ ready: s.ready, hold: s.hold, released: s.released, errors: s.errors, inflight: s.inflight, quiet: Date.now() - s.last }) : null; })()`;

async function readState(page: Page): Promise<(RenderState & { quiet: number }) | null> {
  const raw = await raceTimeout(
    page.evaluate(READ_STATE).catch(() => null),
    2_000,
    null,
  );
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as RenderState & { quiet: number };
  } catch {
    return null;
  }
}

export async function renderApp(req: AppRenderRequest): Promise<AppRenderResult> {
  const endpoint = env('BROWSER_WS_ENDPOINT');
  if (!endpoint) {
    return {
      ok: false,
      error:
        'No browser sidecar on this brain (BROWSER_WS_ENDPOINT is not set), so an app cannot be drawn to a picture. The app itself is saved; open it to see it.',
    };
  }
  try {
    return await withSlot(() => renderInSlot(endpoint, req));
  } catch (err) {
    if (err instanceof RenderBusyError) {
      return {
        ok: false,
        error: 'The renderer is busy with other pictures. Look at the app again in a minute.',
      };
    }
    throw err;
  }
}

async function renderInSlot(endpoint: string, req: AppRenderRequest): Promise<AppRenderResult> {
  const consoleErrors: string[] = [];
  const blocked = new Set<string>();
  const refused = new Set<string>();
  let hostCalls = 0;
  const note = (list: string[], text: string) => {
    if (list.length < MAX_LINES) list.push(text.slice(0, MAX_LINE_CHARS));
  };
  let browser: Awaited<ReturnType<typeof connectRender>> | null = null;
  let page: Page | null = null;
  let over = false;
  let budget: ReturnType<typeof setTimeout> | undefined;
  const overBudget = new Promise<AppRenderResult>((resolve) => {
    budget = setTimeout(
      () =>
        resolve({
          ok: false,
          error: `The app did not finish drawing within ${APP_RENDER_BUDGET_MS / 1000} seconds: it loads too slowly, or something in it runs without end (a loop, a busy animation). Fix that, build again and look again.`,
        }),
      APP_RENDER_BUDGET_MS,
    );
  });

  /** One bridge request from the host page: read, bounded, answered. */
  const answer = async (body: string | undefined): Promise<AppRenderHostAnswer> => {
    if (typeof body !== 'string' || body.length > HOST_CALL_MAX_CHARS) {
      return { ok: false, error: 'This call is too large for a picture.', reason: 'render' };
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return { ok: false, error: 'This call could not be read.', reason: 'render' };
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { ok: false, error: 'This call could not be read.', reason: 'render' };
    }
    // A call that lands after the render is over is no one's.
    if (over) return { ok: false, error: 'The picture is done.', reason: 'render' };
    if (++hostCalls > MAX_HOST_CALLS) return renderRefusal(`more than ${MAX_HOST_CALLS} calls`);
    let out: AppRenderHostAnswer;
    try {
      out = await req.hostCall(message as Record<string, unknown>);
    } catch (err) {
      log('render-app').error(`host call failed: ${errorMessage(err)}`);
      out = { ok: false, error: 'The picture could not answer this call.', reason: 'render' };
    }
    if (!out.ok && out.refused && refused.size < MAX_LINES) refused.add(out.refused);
    return out;
  };

  const work = async (): Promise<AppRenderResult> => {
    const frame = await appFrameDocument(
      req.ownerId,
      APP_RENDER_ORIGIN,
      req.build,
      req.viewer,
      req.theme,
    );
    const libraries = new Set(frame.libraryScripts);
    const nonce = randomBytes(16).toString('base64url');
    const host = hostPageHtml(nonce, MAX_LINES, MAX_LINE_CHARS);
    const view = { width: req.width, height: req.height };
    const viewport: RenderViewport = {
      ...view,
      deviceScaleFactor: Math.min(1, Math.sqrt(MAX_PIXELS / (view.width * view.height))),
    };
    try {
      browser = await connectRender(endpoint, viewport);
    } catch (err) {
      log('render-app').error(`sidecar connect failed: ${errorMessage(err)}`);
      return { ok: false, error: 'The browser sidecar is not reachable right now.' };
    }
    if (over) {
      await browser.disconnect().catch(() => {});
      throw new Error('the render ran out of time before the browser answered');
    }
    page = await browser.newPage();
    if (over) {
      await page.close().catch(() => {});
      throw new Error('the render ran out of time before the page opened');
    }
    const p = page;
    await p.evaluateOnNewDocument(RENDER_INIT);
    await p.setViewport(viewport);
    await p.setRequestInterception(true);
    p.on('request', (r) => {
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
        const ours = parsed?.origin === APP_RENDER_ORIGIN;
        const path = ours ? parsed!.pathname : '';
        const method = r.method();
        if (ours && method === 'GET' && path === '/host') {
          await r.respond({
            status: 200,
            headers: {
              'content-security-policy': hostPageCsp(APP_RENDER_ORIGIN, nonce),
              'x-dns-prefetch-control': 'off',
            },
            contentType: 'text/html; charset=utf-8',
            body: host,
          });
          return;
        }
        if (ours && method === 'GET' && path === '/frame') {
          await r.respond({
            status: 200,
            headers: { 'content-security-policy': frame.csp, 'x-dns-prefetch-control': 'off' },
            contentType: 'text/html; charset=utf-8',
            body: frame.html,
          });
          return;
        }
        // The bridge: only the host page's own call (the app's frame has
        // connect-src 'none' and an opaque origin; this is the second lock).
        if (ours && method === 'POST' && path === '/host-call' && r.frame() === p.mainFrame()) {
          let body = r.postData();
          if (body === undefined && r.hasPostData()) body = await r.fetchPostData();
          const out = await answer(body);
          let text = JSON.stringify(out);
          if (text.length > RENDER_ANSWER_MAX_CHARS) {
            text = JSON.stringify({
              ok: false,
              error:
                'This answer is too large for a picture: add a LIMIT, or draw fewer rows on the first screen.',
            });
          }
          await r.respond({ status: 200, contentType: 'application/json', body: text });
          return;
        }
        if (ours && method === 'GET') {
          const file =
            (await publicFile(path, SERVED_PREFIXES)) ??
            (libraries.has(path) ? await publicFile(path, ['/canvas-runtime/']) : null);
          if (file) {
            await r.respond({
              status: 200,
              headers: { 'access-control-allow-origin': '*' },
              contentType: file.type,
              body: file.body,
            });
            return;
          }
        }
        if (blocked.size < MAX_LINES) {
          blocked.add((ours ? path : originOf(url)).slice(0, MAX_LINE_CHARS));
        }
        await r.abort('blockedbyclient');
      })().catch(() => {});
    });
    p.on('console', (m) => {
      if (m.type() === 'error') note(consoleErrors, m.text());
    });
    p.on('pageerror', (err) => note(consoleErrors, errorMessage(err)));

    await p.goto(`${APP_RENDER_ORIGIN}/host`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });

    // Ready, released if held, and quiet: or the cap.
    const start = Date.now();
    let ready = false;
    let state: Awaited<ReturnType<typeof readState>> = null;
    while (Date.now() - start < READY_MAX_MS && !over) {
      state = await readState(p);
      if (
        state?.ready &&
        (!state.hold || state.released) &&
        state.inflight === 0 &&
        state.quiet >= QUIET_MS
      ) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    const settle = Math.min(AT_SECONDS_MAX, Math.max(0, req.atSeconds));
    await new Promise((r) => setTimeout(r, settle * 1000));
    // The budget ran out meanwhile: the page is closed, nothing to take.
    if (over) return { ok: false, error: 'The picture ran out of time.' };
    state = (await readState(p)) ?? state;
    for (const e of Array.isArray(state?.errors) ? state.errors : []) {
      if (typeof e === 'string') note(consoleErrors, e);
    }

    let png = Buffer.from(await p.screenshot({ type: 'png' }));
    let mime: 'image/png' | 'image/jpeg' = 'image/png';
    if (png.length > MAX_IMAGE_BYTES) {
      png = Buffer.from(await p.screenshot({ type: 'jpeg', quality: 70 }));
      mime = 'image/jpeg';
    }
    if (png.length > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error:
          'The app drew a picture too large to keep (it is mostly noise). Look at a smaller window with width and height.',
      };
    }
    return {
      ok: true,
      png,
      mime,
      width: view.width,
      height: view.height,
      ready,
      consoleErrors: [...new Set(consoleErrors)].slice(0, 20),
      blocked: [...blocked].slice(0, 20),
      refused: [...refused].slice(0, 20),
      hostCalls,
    };
  };
  try {
    return await Promise.race([
      work().catch((err: unknown): AppRenderResult => {
        log('render-app').error(`render failed: ${errorMessage(err)}`);
        return { ok: false, error: 'The app could not be drawn (the browser gave up on it).' };
      }),
      overBudget,
    ]);
  } finally {
    over = true;
    clearTimeout(budget);
    await closeRender(page as Page | null, browser);
  }
}
