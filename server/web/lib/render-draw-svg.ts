import puppeteer from 'puppeteer-core';
import { printOrigin } from './render-pdf';

/**
 * Regenerate a draw's SVG snapshot in the browser sidecar.
 *
 * `draws.scene_svg` is a CACHE of a render, not a source of truth. The fast
 * path stays the editor capturing it at commit; this fills the cache when
 * nothing did — an agent-authored drawing, an Excalidraw upgrade that made the
 * stored one stale, or an export that failed in the client. Chromium is never
 * on the hot path: see docs/draw-render-fallback-plan.md §4.4 for exactly which
 * callers may fire this (public share traffic may NOT).
 *
 * The mechanism: a real
 * Chromium loads our own owner-authed route, the browser-only renderer runs
 * there, and we read the result out of the page. There is no Node path that
 * produces a correct drawing — text layout needs real font metrics.
 */

/** Thrown when the sidecar isn't configured or can't be reached. Callers treat
 *  it as a cache miss (placeholder), never as a request failure. */
export class DrawRendererUnavailableError extends Error {
  constructor(detail: string) {
    super(`Draw renderer unavailable: ${detail}`);
    this.name = 'DrawRendererUnavailableError';
  }
}

/** How long the island gets to produce an SVG before we give up on it. Well
 *  above a realistic render (fonts are local, no network), low enough that a
 *  wedged sidecar can't hold a request open. */
const RENDER_TIMEOUT_MS = 20_000;

export type DrawRenderResult = {
  svg: string | null;
  /** The island rendered without some scene images (missing/hung fetches).
   *  The caller decides whether that beats what it already has. */
  partial: boolean;
};

/**
 * Render `/render/draws/<id>` in the sidecar and return the SVG string.
 * `svg` is null when the scene is empty or the island reported a failure —
 * both are "no snapshot", which is a legitimate state, not an error.
 * Throws DrawRendererUnavailableError when the sidecar itself is unusable.
 */
export async function renderDrawSvg(nodeId: string, cookie: string): Promise<DrawRenderResult> {
  const endpoint = process.env.BROWSER_WS_ENDPOINT;
  if (!endpoint) throw new DrawRendererUnavailableError('BROWSER_WS_ENDPOINT is not set');

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  } catch (e) {
    throw new DrawRendererUnavailableError(
      `could not connect to ${endpoint.replace(/token=[^&]*/, 'token=…')} (${(e as Error).message})`,
    );
  }

  try {
    const page = await browser.newPage();
    if (cookie) await page.setExtraHTTPHeaders({ cookie });
    await page.goto(`${printOrigin()}/render/draws/${encodeURIComponent(nodeId)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // The island always sets __mantleDrawDone, success or failure, so this
    // waits on completion rather than on success.
    await page.waitForFunction(() => window.__mantleDrawDone === true, {
      timeout: RENDER_TIMEOUT_MS,
    });

    const result = await page.evaluate(() => ({
      svg: window.__mantleDrawSvg ?? null,
      error: window.__mantleDrawError ?? null,
      partial: window.__mantleDrawPartial === true,
    }));

    if (result.error) {
      // 'empty scene' is routine; anything else is worth a line in the log.
      if (result.error !== 'empty scene') {
        console.warn(`[draw-render] ${nodeId}: ${result.error}`);
      }
      return { svg: null, partial: result.partial };
    }
    if (result.partial) {
      console.warn(`[draw-render] ${nodeId}: rendered without some scene images`);
    }
    return { svg: result.svg, partial: result.partial };
  } finally {
    // Disconnect, never close: browserless owns the browser lifecycle.
    await browser.disconnect().catch(() => {});
  }
}

declare global {
  interface Window {
    __mantleDrawSvg?: string;
    __mantleDrawDone?: boolean;
    __mantleDrawError?: string;
    __mantleDrawPartial?: boolean;
  }
}
