import 'server-only';
import puppeteer from 'puppeteer-core';

/**
 * PDF rendering for Pages via the BROWSER SIDECAR — Mantle's Tika-for-browsers.
 *
 * Rather than re-implement the page schema a fourth time (editor /
 * markdownToDoc / renderPageDoc / renderDocx), a real Chromium loads the app's
 * OWN owner-authed `/print/pages/<id>` route — with the caller's session cookie
 * forwarded — and prints it. The PDF therefore reuses the live page CSS
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
 *   MANTLE_PRINT_ORIGIN  origin the SIDECAR uses to reach this app.
 *                        prod compose: http://web:3000 (service DNS).
 *                        dev default:  http://host.docker.internal:$PORT
 *                        (the app runs as native node; the sidecar container
 *                        reaches the host via its host-gateway alias).
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

/** The origin Chromium-in-the-sidecar uses to reach this app's /print route. */
export function printOrigin(): string {
  if (process.env.MANTLE_PRINT_ORIGIN) return process.env.MANTLE_PRINT_ORIGIN.replace(/\/+$/, '');
  // Dev: the app is native node on the host; the sidecar reaches it through the
  // host-gateway alias baked into docker-compose.dev.yml.
  return `http://host.docker.internal:${process.env.PORT || '3000'}`;
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
  const endpoint = process.env.BROWSER_WS_ENDPOINT;
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
 * Render an app URL (an owner-authed `/print/...` surface) to a PDF Buffer.
 * `cookie` is the caller's raw `Cookie` header, forwarded so the print route —
 * and every image subresource it loads from the authed asset route —
 * authenticates as the owner.
 */
export async function renderUrlToPdf(url: string, cookie: string): Promise<Buffer> {
  const endpoint = process.env.BROWSER_WS_ENDPOINT;
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
    const page = await browser.newPage();
    if (cookie) await page.setExtraHTTPHeaders({ cookie });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
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
