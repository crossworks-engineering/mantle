import puppeteer from 'puppeteer-core';
import { env } from '@mantle/config';
import { openRenderPage } from './render-sandbox';

export { printOrigin } from './render-sandbox';

/**
 * PDF rendering for Pages via the BROWSER SIDECAR — Mantle's Tika-for-browsers.
 *
 * Rather than re-implement the page schema a fourth time (editor /
 * markdownToDoc / renderPageDoc / renderDocx), a real Chromium loads the app's
 * OWN admin-only `/print/pages/<id>` route, carrying a render cookie for the
 * acting admin (lib/render-sandbox.ts), and prints it. The PDF therefore reuses the live page CSS
 * (callouts, code highlight, KaTeX, images, asides) and looks exactly like the
 * on-screen page.
 *
 * The browser is NOT embedded in this process. Like Tika, it runs as its own
 * stateless container (browserless/chromium — the `browser` compose service)
 * with its own memory ceiling, session queue, and per-session timeout; we
 * connect over websocket (BROWSER_WS_ENDPOINT) per request and disconnect when
 * done — browserless owns the browser lifecycle, so a crashed or leaked
 * Chromium never takes the web server with it. `puppeteer-core` is the pure
 * driver (no bundled browser download, ~1 GB off the app image).
 *
 * Config:
 *   BROWSER_WS_ENDPOINT  ws URL incl. token, e.g. ws://browser:3000?token=…
 *                        dev compose publishes 127.0.0.1:9222 →
 *                        ws://127.0.0.1:9222?token=mantle
 *   MANTLE_PRINT_ORIGIN  origin the SIDECAR uses to reach this app (see
 *                        printOrigin in lib/render-sandbox.ts).
 */

/** Thrown when the sidecar isn't configured or can't be reached — the export
 *  route maps it to a 503 instead of a generic 500. */
export class PdfRendererUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `PDF renderer unavailable: ${detail}. ` +
        `The browser sidecar (compose service 'browser') must be running and ` +
        `BROWSER_WS_ENDPOINT set.`,
    );
    this.name = 'PdfRendererUnavailableError';
  }
}

/**
 * Probe the browser sidecar for the system-health dashboard — the analog of
 * `tikaVersion` in @mantle/files. Never throws.
 *
 *   up: null   → BROWSER_WS_ENDPOINT unset (unconfigured — e.g. detached dev);
 *                rendered as a neutral pill, not a red one.
 *   up: false  → configured but /meta didn't answer (sidecar down).
 *   up: true   → sidecar healthy; `version` carries browserless + Chromium.
 *
 * The probe converts the websocket endpoint to HTTP (same host/port/token) and
 * hits browserless's /meta — the same endpoint the compose healthcheck uses.
 */
export async function browserHealth(
  timeoutMs = 1_500,
): Promise<{ up: boolean | null; version: string | null }> {
  const endpoint = env('BROWSER_WS_ENDPOINT');
  if (!endpoint) return { up: null, version: null };
  try {
    const url = new URL(endpoint.replace(/^ws/, 'http'));
    url.pathname = '/meta';
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { up: false, version: null };
    const meta = (await res.json()) as { version?: string; chromium?: string };
    const version = [
      meta.version ? `browserless ${meta.version}` : null,
      meta.chromium ? `Chromium ${meta.chromium}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return { up: true, version: version || null };
  } catch {
    return { up: false, version: null };
  }
}

/**
 * Render an app URL (a `/print/...` surface) to a PDF Buffer. `renderToken` is
 * a render cookie value (buildRenderToken) for the acting admin and the node
 * the URL prints; the print route and the image routes it loads accept it, and
 * nothing outside the print origin is ever fetched (lib/render-sandbox.ts).
 */
export async function renderUrlToPdf(url: string, renderToken: string): Promise<Buffer> {
  const endpoint = env('BROWSER_WS_ENDPOINT');
  if (!endpoint) throw new PdfRendererUnavailableError('BROWSER_WS_ENDPOINT is not set');

  // Connect per request: browserless pools/queues sessions on its side
  // (CONCURRENT/QUEUED/TIMEOUT), so each connect is a managed, capped session.
  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  } catch (e) {
    throw new PdfRendererUnavailableError(
      `could not connect to ${endpoint.replace(/token=[^&]*/, 'token=…')} (${(e as Error).message})`,
    );
  }

  try {
    const page = await openRenderPage(browser, renderToken);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
    // Diagram blocks render client-side after load (print.ts injects a script
    // tagged data-diagram-print that sets data-diagrams-ready on completion —
    // success or failure). Pages without diagrams have no such script and pass
    // immediately; a hung render degrades to the source blocks, never a
    // failed export.
    await page
      .waitForFunction(
        () =>
          !document.querySelector('script[data-diagram-print]') ||
          document.documentElement.hasAttribute('data-diagrams-ready'),
        { timeout: 15_000 },
      )
      .catch(() => {});
    const bytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
    });
    return Buffer.from(bytes);
  } finally {
    // disconnect, never close: the browser belongs to the sidecar, and
    // browserless reaps the session (and its pages) on disconnect.
    await browser.disconnect().catch(() => {});
  }
}
