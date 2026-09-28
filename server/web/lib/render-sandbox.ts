import type { Browser, Page } from 'puppeteer-core';
import { env } from '@mantle/config';
import { RENDER_COOKIE_NAME } from './auth-constants';

/**
 * The one way a server-side render opens a page in the browser sidecar
 * (lib/render-pdf.ts, render-draw-svg.ts, render-draw-png.ts).
 *
 * A render loads one of our own render surfaces (/print/pages, /print/draws,
 * /render/draws) as an admin, so whatever that page pulls in is fetched with
 * that admin's credential. Until audit F01 the credential was a full session
 * cookie for the anchor, set with setExtraHTTPHeaders, which Chromium attaches
 * to EVERY request: a page image with an outside src handed the anchor's
 * session to that host, and the sidecar has internet egress. Three locks now,
 * each enough on its own for the outside-host case:
 *
 *  - The credential is a render cookie (kind 'r', lib/auth/tokens.ts) minted
 *    for the acting admin, accepted only on the render surfaces and the byte
 *    routes they load. It is never a session.
 *  - It is a real cookie on the print origin, not an extra header, so
 *    Chromium only sends it there.
 *  - Request interception aborts every request that is not to the print
 *    origin (data: and blob: stay allowed: they are inline, no network).
 *
 * The render surfaces also send a CSP that allows only their own origin
 * (server/pages/print.ts), which covers what interception does not see (a
 * WebSocket, say).
 */

/** The origin Chromium-in-the-sidecar uses to reach this app's render routes.
 *
 *   MANTLE_PRINT_ORIGIN  prod compose: http://web:3000 (service DNS).
 *   dev default:         http://host.docker.internal:$PORT (the app runs as
 *                        native node; the sidecar container reaches the host
 *                        via its host-gateway alias).
 */
export function printOrigin(): string {
  const configured = env('MANTLE_PRINT_ORIGIN');
  if (configured) return configured.replace(/\/+$/, '');
  // Dev: the app is native node on the host; the sidecar reaches it through the
  // host-gateway alias baked into docker-compose.dev.yml.
  return `http://host.docker.internal:${env('PORT') || '3000'}`;
}

/** Whether the sidecar may fetch `url` during a render: the print origin
 *  itself, and data:/blob: URLs. Anything else (another host, another port,
 *  another scheme, or a URL that does not parse) is refused. */
export function isRenderRequestAllowed(url: string, origin: string = printOrigin()): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** The origin of a URL for a log line: never its path or query. */
function originForLog(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'an unparseable URL';
  }
}

/**
 * Open a page for a render: interception on (only the print origin gets
 * through), and the render cookie set on the print origin. The caller
 * navigates, reads the result, and disconnects as before.
 */
export async function openRenderPage(browser: Browser, renderToken: string): Promise<Page> {
  const origin = new URL(printOrigin());
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if (isRenderRequestAllowed(req.url(), origin.origin)) {
      void req.continue().catch(() => {});
      return;
    }
    // A page image from another site prints without it; say why, without the
    // path (it can carry that site's own token).
    console.warn(`[render] blocked a request to ${originForLog(req.url())}`);
    void req.abort('blockedbyclient').catch(() => {});
  });
  await page.browserContext().setCookie({
    name: RENDER_COOKIE_NAME,
    value: renderToken,
    domain: origin.hostname,
    path: '/',
    httpOnly: true,
    // The print origin is plain http inside the compose network.
    secure: origin.protocol === 'https:',
    sameSite: 'Strict',
  });
  return page;
}
