import puppeteer from 'puppeteer-core';
import { printOrigin } from './render-pdf';
import { DrawRendererUnavailableError } from './render-draw-svg';

/**
 * Rasterize a draw's committed SVG snapshot to PNG in the browser sidecar.
 *
 * Word is the one export surface that cannot take the snapshot as it stands:
 * `ImageRun` embeds png/jpg/gif/bmp only, so a page with a drawing exported to
 * .docx used to print `[drawing: alt]` while Markdown, HTML, /s and PDF all
 * showed the picture.
 *
 * This does NOT re-run Excalidraw. It screenshots `/print/draws/:id` — the same
 * white-sheet surface the PDF export prints, where the snapshot is already an
 * `<img>` with its fonts inlined. So the raster is a copy of the bytes every
 * other surface serves, not a second render that could drift from them, and it
 * costs a screenshot rather than a scene render. `render-draw-svg.ts` remains
 * the only thing that produces a snapshot.
 *
 * Nothing is stored. The plan's "no PNG alongside the SVG" (§8) stands: this is
 * a transient export artefact, and there is no second cache to invalidate.
 */

/** How long the snapshot gets to decode before we give up on it. The page is
 *  a single same-origin data: image, so this is generous. */
const DECODE_TIMEOUT_MS = 15_000;
/** Raster at 2× so the picture survives being printed rather than looked at on
 *  screen. The returned width/height stay in CSS px, so the document still
 *  SIZES it at 1× and the extra pixels buy sharpness, not scale. */
const PIXEL_RATIO = 2;
/** Viewport width is what BOUNDS the raster: the sheet's `max-width:100%`
 *  shrinks any bigger snapshot to fit, so the PNG is never wider than
 *  width × PIXEL_RATIO however large the drawing is. 800 sits comfortably
 *  above the ~600px a Word body column gives an image, so a full-width
 *  drawing is still oversampled ~2.5× — and an Excalidraw export declares
 *  itself at 2× its own viewBox, which uncapped would raster at four times
 *  the size that buys anything. */
const VIEWPORT = { width: 800, height: 1000 };

export type DrawPng = {
  bytes: Buffer;
  /** Intended display size in CSS px — the raster itself is PIXEL_RATIO× this. */
  width: number;
  height: number;
};

/**
 * Screenshot `/print/draws/<id>` and return the PNG. Null means "no picture to
 * embed": the drawing has no committed snapshot, or the image failed to decode.
 * Throws DrawRendererUnavailableError when the sidecar itself is unusable, so
 * a caller can tell a missing drawing from a missing browser.
 */
export async function renderDrawPng(nodeId: string, cookie: string): Promise<DrawPng | null> {
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
    await page.setViewport({ ...VIEWPORT, deviceScaleFactor: PIXEL_RATIO });
    if (cookie) await page.setExtraHTTPHeaders({ cookie });
    const res = await page.goto(`${printOrigin()}/print/draws/${encodeURIComponent(nodeId)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    // 404 is the routine answer for a drawing with nothing committed — the
    // print route refuses to invent one. Not an error, just no picture.
    if (!res || !res.ok()) return null;

    const img = await page.$('img');
    if (!img) return null;
    // `complete` alone is true for a FAILED load too, so check the decoded
    // width as well; a snapshot Chromium won't parse must degrade to the
    // placeholder rather than screenshot as a blank rectangle.
    const size = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('img');
          if (!el || !el.complete || el.naturalWidth === 0) return null;
          const rect = el.getBoundingClientRect();
          return { width: Math.round(rect.width), height: Math.round(rect.height) };
        },
        { timeout: DECODE_TIMEOUT_MS },
      )
      .then((handle) => handle.jsonValue() as Promise<{ width: number; height: number }>)
      .catch(() => null);
    if (!size || size.width < 1 || size.height < 1) return null;

    // The element box, so the sheet's padding stays out of the picture.
    const bytes = Buffer.from(await img.screenshot({ type: 'png' }));
    return { bytes, width: size.width, height: size.height };
  } finally {
    // Disconnect, never close: browserless owns the browser lifecycle.
    await browser.disconnect().catch(() => {});
  }
}
