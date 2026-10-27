/**
 * PDF → PNG rasterization for the OCR fallback.
 *
 * A scanned / image-only PDF has no text layer, so `parseDocumentBytes`
 * (pdf-parse) yields nothing. The extractor renders its pages to PNG here and
 * runs each through the vision worker (OCR) — the same path images already
 * take. Pure Node: pdfjs opened through ./pdfjs.ts (the package's one PDF
 * entry point, with its picture limit) and `@napi-rs/canvas`, no system
 * packages.
 *
 * The render runs in a worker thread (./isolate.ts): a page is decoded
 * pictures and a canvas, memory the V8 heap does not hold, and a 747 KB PDF
 * holding one 16,000 x 16,000 picture used to take this process to 5.4 GB
 * and stop its event loop for two seconds. Each page's canvas is held to
 * {@link PDF_MAX_CANVAS_PIXELS} (a larger page is scaled down to fit), one
 * page at a time, and a picture past the pdfjs limit is left out of the
 * render.
 *
 * Kept as a separate entry point (`@mantle/files/rasterize`) with the heavy
 * deps behind dynamic imports, so they load only when a textless PDF shows
 * up, and stay out of the Next.js (server/web) module graph.
 */

import { PDF_MAX_CANVAS_PIXELS } from './pdfjs';

/** Default page cap — bounds rasterization memory + per-page vision spend.
 *  A passport is one page; a long scanned doc is capped here. */
export const DEFAULT_MAX_OCR_PAGES = 10;

export type RasterPage = {
  /** 1-based page number within the PDF. */
  pageNumber: number;
  /** PNG-encoded bytes of the rendered page. */
  png: Buffer;
};

/**
 * Render up to `maxPages` pages of a PDF to PNG buffers, in a worker thread.
 * `viewportScale` 2 roughly doubles resolution for cleaner OCR. Throws on an
 * unrenderable / corrupt PDF (callers wrap this in a trace step and treat a
 * throw or an empty result as "couldn't OCR"), a DocumentLimitError when a
 * limit stopped the render, and a DocumentReadRetryableError when it could
 * not run in time.
 */
export async function rasterizePdfToPngs(
  bytes: Buffer,
  opts?: { maxPages?: number; viewportScale?: number },
): Promise<RasterPage[]> {
  const maxPages = Math.max(1, opts?.maxPages ?? DEFAULT_MAX_OCR_PAGES);
  const { runIsolated } = await import('./isolate');
  return runIsolated('pdfRaster', [bytes, maxPages, opts?.viewportScale ?? 2.0]);
}

/** The scale that keeps a `width` x `height` (at scale 1) page within the
 *  canvas limit, at most `wanted`. */
export function fittedScale(width: number, height: number, wanted: number): number {
  const area = width * wanted * (height * wanted);
  if (area <= PDF_MAX_CANVAS_PIXELS) return wanted;
  return wanted * Math.sqrt(PDF_MAX_CANVAS_PIXELS / area) * 0.999;
}

type CanvasAndContext = { canvas: { encode(kind: 'png'): Promise<Buffer> }; context: unknown };
type CanvasFactory = {
  create(w: number, h: number): CanvasAndContext;
  destroy(c: CanvasAndContext): void;
};

/** {@link rasterizePdfToPngs} on the calling thread: the parse worker's job.
 *  One page at a time, one canvas live. */
export async function rasterizePdfToPngsInProcess(
  bytes: Buffer,
  maxPages: number,
  viewportScale: number,
): Promise<RasterPage[]> {
  const { openPdf } = await import('./pdfjs');
  const task = await openPdf(bytes);
  try {
    const doc = await task.promise;
    const factory = (doc as unknown as { canvasFactory?: CanvasFactory }).canvasFactory;
    if (!factory || typeof factory.create !== 'function') {
      throw new Error('pdfjs did not provide a canvas factory');
    }
    const out: RasterPage[] = [];
    const last = Math.min(doc.numPages, Math.max(1, maxPages));
    for (let n = 1; n <= last; n++) {
      const page = await doc.getPage(n);
      let made: CanvasAndContext | null = null;
      try {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: fittedScale(base.width, base.height, viewportScale),
        });
        const w = Math.floor(viewport.width);
        const h = Math.floor(viewport.height);
        if (w <= 0 || h <= 0) continue;
        made = factory.create(w, h);
        await page.render({
          canvasContext: made.context as CanvasRenderingContext2D,
          canvas: made.canvas as unknown as HTMLCanvasElement,
          viewport,
        }).promise;
        out.push({ pageNumber: n, png: Buffer.from(await made.canvas.encode('png')) });
      } finally {
        if (made) factory.destroy(made);
        page.cleanup();
      }
    }
    return out;
  } finally {
    await task.destroy().catch(() => {});
  }
}
