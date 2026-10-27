/**
 * PDF → PNG rasterization for the OCR fallback.
 *
 * A scanned / image-only PDF has no text layer, so `parseDocumentBytes`
 * (pdf-parse) yields nothing. The extractor renders its pages to PNG here and
 * runs each through the vision worker (OCR), the same path images already
 * take. Pure Node: pdfjs draws onto an `@napi-rs/canvas` canvas (prebuilt
 * native binaries), no system packages required.
 *
 * Bounded on both axes that can blow the process up: the document is opened
 * through `openPdf`, so pdfjs drops an embedded image over
 * `PDF_MAX_IMAGE_PIXELS` instead of decoding it, and each page's canvas is
 * held to `MAX_RENDER_PIXELS` by lowering that page's scale. One page renders
 * at a time, so one canvas is alive at a time.
 *
 * Kept as a separate entry point (`@mantle/files/rasterize`) with the heavy
 * deps behind dynamic imports, so they load only when a textless PDF actually
 * shows up, and the native dep stays out of the Next.js (server/web) graph.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { openPdf } from './pdf-open';

/** Default page cap: bounds rasterization memory + per-page vision spend.
 *  A passport is one page; a long scanned doc is capped here. */
export const DEFAULT_MAX_OCR_PAGES = 10;

/** The largest canvas one page may render to, in pixels (4096 x 4096, so
 *  64 MB of RGBA). An A1 sheet at the default scale 2 fits; a bigger sheet
 *  renders at a lower scale rather than a bigger canvas. */
export const MAX_RENDER_PIXELS = 4096 * 4096;

/** A page that would need a scale below this to fit `MAX_RENDER_PIXELS` is
 *  not a page anyone can read: its area is past 16 x the cap in PDF points,
 *  beyond the 14400 x 14400 pt the PDF spec allows (only a `UserUnit` or a
 *  broken MediaBox gets there). It is skipped, not rendered. */
const MIN_RENDER_SCALE = 0.25;

export type RasterPage = {
  /** 1-based page number within the PDF. */
  pageNumber: number;
  /** PNG-encoded bytes of the rendered page. */
  png: Buffer;
};

/**
 * Every page asked for was too large to render. A verdict on the document,
 * not a failure of the machinery: rendering it again gives the same answer,
 * so the extractor records it as a terminal skip (`pdf_too_large`) instead of
 * retrying. Matched by `name` (see `isPdfLimitError`) so a caller that loaded
 * this module through another import path still recognises it.
 */
export class PdfLimitError extends Error {
  override readonly name = 'PdfLimitError';
}

export function isPdfLimitError(err: unknown): err is PdfLimitError {
  return err instanceof Error && err.name === 'PdfLimitError';
}

/**
 * The scale to render a page at, given its size at scale 1 (PDF points times
 * its UserUnit) and the scale the caller asked for: the asked-for scale, or
 * lower if that would pass `MAX_RENDER_PIXELS`. Null for a page to skip (no
 * area, non-finite, or absurdly large).
 */
export function pageRenderScale(width: number, height: number, wanted: number): number | null {
  const area = width * height;
  if (!(width > 0 && height > 0 && Number.isFinite(area))) return null;
  const fit = Math.sqrt(MAX_RENDER_PIXELS / area);
  if (fit < MIN_RENDER_SCALE) return null;
  const scale = Math.min(wanted, fit);
  if (Math.floor(width * scale) < 1 || Math.floor(height * scale) < 1) return null;
  return scale;
}

/** pdfjs's CMap and standard-font directories, as `getDocument` wants them
 *  (trailing slash). Resolved from the installed package, not the working
 *  directory, so they are found wherever the process runs. */
function pdfjsAssetUrls(): { cMapUrl: string; standardFontDataUrl: string } {
  const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  return {
    cMapUrl: `${path.join(root, 'cmaps')}/`,
    standardFontDataUrl: `${path.join(root, 'standard_fonts')}/`,
  };
}

/**
 * Render up to `maxPages` pages of a PDF to PNG buffers. `viewportScale` 2
 * roughly doubles resolution for cleaner OCR; a page too big for
 * `MAX_RENDER_PIXELS` at that scale renders at the largest scale that fits.
 * Throws on an unrenderable / corrupt PDF, and a `PdfLimitError` when every
 * page asked for was too large to render at all. Callers wrap this in a trace
 * step and treat a throw or an empty result as "couldn't OCR".
 */
export async function rasterizePdfToPngs(
  bytes: Buffer,
  opts?: { maxPages?: number; viewportScale?: number },
): Promise<RasterPage[]> {
  const maxPages = Math.max(1, opts?.maxPages ?? DEFAULT_MAX_OCR_PAGES);
  const wanted = opts?.viewportScale ?? 2.0;
  const { createCanvas } = await import('@napi-rs/canvas');
  const { task } = await openPdf(bytes, {
    ...pdfjsAssetUrls(),
    cMapPacked: true,
    // The settings the previous renderer (pdf-to-png-converter) used, so a
    // normal page renders to the same pixels.
    useSystemFonts: false,
    enableXfa: true,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const count = Math.min(doc.numPages, maxPages);
    const out: RasterPage[] = [];
    const tooLarge: string[] = [];
    for (let pageNumber = 1; pageNumber <= count; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = pageRenderScale(base.width, base.height, wanted);
        if (scale === null) {
          tooLarge.push(
            `page ${pageNumber} is ${Math.round(base.width)}x${Math.round(base.height)} pt`,
          );
          continue;
        }
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
        const context = canvas.getContext('2d');
        await page.render({
          // pdfjs types these as the DOM canvas; in Node it draws on
          // @napi-rs/canvas, which is what its own canvas factory makes.
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;
        out.push({ pageNumber, png: await canvas.encode('png') });
      } finally {
        page.cleanup();
      }
    }
    if (out.length === 0 && tooLarge.length > 0) {
      throw new PdfLimitError(
        `PDF pages too large to render (${tooLarge.join('; ')}); the render limit is ${MAX_RENDER_PIXELS} pixels a page`,
      );
    }
    return out;
  } finally {
    await task.destroy().catch(() => {});
  }
}
