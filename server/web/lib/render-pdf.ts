import puppeteer from 'puppeteer-core';
import { env } from '@mantle/config';
import { buildRenderToken, documentsAvailable, runDocuments } from '@mantle/documents';
import { defineDomainError, NET_TIMEOUTS, timeoutSignal } from '@mantle/std';
import { openRenderPage, printOrigin } from './render-sandbox';
import {
  chromeDocument,
  DEFAULT_PRINT_OPTIONS,
  mmToInches,
  paperInches,
  printChrome,
  type PrintOptions,
} from './print-options';

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
 * Since the documents engine (packages/documents, plan page f7c67c92 P5):
 * renderNodeToPdf prints through Gotenberg's chromium/convert/url when the
 * `documents` service is on, with the same print surface, the same render
 * cookie (minted by the package for the acting admin) and the print options
 * (print-options.ts); the browser sidecar below is the fallback while it is
 * off, and keeps the drawing SVG re-render for good (P6). Nothing on the
 * browser service is lowered yet.
 *
 * Config:
 *   BROWSER_WS_ENDPOINT  ws URL incl. token, e.g. ws://browser:3000?token=…
 *                        dev compose publishes 127.0.0.1:9222 →
 *                        ws://127.0.0.1:9222?token=mantle
 *   MANTLE_PRINT_ORIGIN  origin the SIDECAR uses to reach this app (see
 *                        printOrigin in @mantle/documents).
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
    // For the operator: the export route logged it where it answered 503.
    console.error('[export] pdf renderer unavailable:', this.message);
  }
}

// The one error answer (A10 part 2, @mantle/std domain-errors.ts): what
// the export route answered by hand.
defineDomainError(PdfRendererUnavailableError, {
  reason:
    'the PDF sidecar is not set up or not reachable; the message says what the operator starts',
  status: 503,
});

/**
 * Probe the browser sidecar for the system-health dashboard — the analog of
 * `parserHealth` in @mantle/files. Never throws.
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
  timeoutMs: number = NET_TIMEOUTS.localProbe,
): Promise<{ up: boolean | null; version: string | null }> {
  const endpoint = env('BROWSER_WS_ENDPOINT');
  if (!endpoint) return { up: null, version: null };
  try {
    const url = new URL(endpoint.replace(/^ws/, 'http'));
    url.pathname = '/meta';
    const res = await fetch(url, { signal: timeoutSignal(timeoutMs) });
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

/** The bounded diagram wait: the print surface marks data-diagrams-ready
 *  when its diagrams rendered (or failed); a page with none passes at once;
 *  a hung render prints the source blocks after 15 s, never a failed
 *  export (the same bound the documents engine gets, PAGE_WAIT_EXPRESSION). */
const DIAGRAM_WAIT_MS = 15_000;

/**
 * Print a page or a drawing of this brain to a PDF: through the documents
 * engine when the `documents` service is on, else the browser sidecar. The
 * caller has warmed what the print surface embeds (drawing snapshots).
 * `actorId` is the acting admin the render cookie names.
 */
export async function renderNodeToPdf(
  kind: 'page' | 'draw',
  nodeId: string,
  who: { ownerId: string; actorId: string },
  options: PrintOptions = DEFAULT_PRINT_OPTIONS,
): Promise<Buffer> {
  if (documentsAvailable()) {
    const chrome = printChrome(options);
    const paper = paperInches(options);
    const res = await runDocuments(
      {
        route: 'chromium/convert/url',
        inputs: {
          node_id: nodeId,
          ...(chrome.header ? { header_html: chromeDocument(chrome.header) } : {}),
          ...(chrome.footer ? { footer_html: chromeDocument(chrome.footer) } : {}),
        },
        options: {
          paperWidth: paper.width,
          paperHeight: paper.height,
          marginTop: mmToInches(options.margins.top),
          marginBottom: mmToInches(options.margins.bottom),
          marginLeft: mmToInches(options.margins.left),
          marginRight: mmToInches(options.margins.right),
          printBackground: true,
        },
      },
      { ownerId: who.ownerId, actorLoginId: who.actorId },
      'bytes',
    );
    if (res.kind !== 'bytes') throw new PdfRendererUnavailableError('the engine answered no bytes');
    return res.bytes;
  }
  const token = buildRenderToken({ ownerId: who.ownerId, actorId: who.actorId, nodeId });
  return renderUrlToPdf(
    `${printOrigin()}/print/${kind === 'page' ? 'pages' : 'draws'}/${nodeId}`,
    token,
    options,
  );
}

/**
 * Render an app URL (a `/print/...` surface) to a PDF Buffer in the browser
 * sidecar. `renderToken` is a render cookie value (buildRenderToken) for the
 * acting admin and the node the URL prints; the print route and the image
 * routes it loads accept it, and nothing outside the print origin is ever
 * fetched (lib/render-sandbox.ts).
 */
export async function renderUrlToPdf(
  url: string,
  renderToken: string,
  options: PrintOptions = DEFAULT_PRINT_OPTIONS,
): Promise<Buffer> {
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
        { timeout: DIAGRAM_WAIT_MS },
      )
      .catch(() => {});
    const chrome = printChrome(options);
    const paper = paperInches(options);
    const bytes = await page.pdf({
      width: `${paper.width}in`,
      height: `${paper.height}in`,
      printBackground: true,
      margin: {
        top: `${options.margins.top}mm`,
        bottom: `${options.margins.bottom}mm`,
        left: `${options.margins.left}mm`,
        right: `${options.margins.right}mm`,
      },
      displayHeaderFooter: Boolean(chrome.header || chrome.footer),
      headerTemplate: chrome.header ?? '<span></span>',
      footerTemplate: chrome.footer ?? '<span></span>',
    });
    return Buffer.from(bytes);
  } finally {
    // disconnect, never close: the browser belongs to the sidecar, and
    // browserless reaps the session (and its pages) on disconnect.
    await browser.disconnect().catch(() => {});
  }
}
