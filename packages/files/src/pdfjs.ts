/**
 * The one way this package opens a PDF with pdfjs. Every reader goes
 * through it: the text layer (pdf-parse hands these parameters straight to
 * pdfjs), the figures, the page count, the password read and the page
 * render for OCR. A new reader must too, so the limits below hold for all
 * of them.
 *
 * A PDF is small on disk and large in memory at will: a 747 KB file can hold
 * one 16,000 x 16,000 picture (a deflated run of zeros), which pdfjs decodes
 * to 768 MB of pixels and then, for the figures pass, copies twice more into
 * RGBA and a canvas: 1.9 GB, all outside the V8 heap cap of the read's
 * thread (./isolate.ts). So:
 *
 *  - `maxImageSize` ({@link PDF_MAX_IMAGE_PIXELS}): pdfjs leaves out any
 *    picture past 25 million pixels (about 100 MB as RGBA) before it decodes
 *    it. A scan at 300 dpi of an A3 page is about 17 million.
 *  - Page renders are held to {@link PDF_MAX_CANVAS_PIXELS} (./rasterize.ts
 *    scales a larger page down to fit).
 *  - No OffscreenCanvas, no ImageDecoder, no XFA forms: pdfjs's own decoders
 *    only, the same in every Node process.
 *
 * What the picture limit cannot see (a soft mask or a JPEG whose own size
 * is larger than its dictionary says) is caught by the memory watch in
 * ./isolate.ts, which stops the read.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';

/** Pixels (width x height) a picture in a PDF may have; larger ones are
 *  left out unread. */
export const PDF_MAX_IMAGE_PIXELS = 25_000_000;

/** Pixels a rendered page may have. */
export const PDF_MAX_CANVAS_PIXELS = 25_000_000;

let assetDirs: { cMapUrl: string; standardFontDataUrl: string } | null | undefined;

/** pdfjs's character maps and standard fonts, from the installed package,
 *  so a page that names Helvetica without embedding it still renders. Null
 *  when the package cannot be found on disk (pdfjs then warns and
 *  substitutes). */
function pdfjsAssets(): { cMapUrl: string; standardFontDataUrl: string } | null {
  if (assetDirs !== undefined) return assetDirs;
  try {
    const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
    assetDirs = {
      cMapUrl: `${path.join(root, 'cmaps')}/`,
      standardFontDataUrl: `${path.join(root, 'standard_fonts')}/`,
    };
  } catch {
    assetDirs = null;
  }
  return assetDirs;
}

/**
 * The `getDocument` parameters for these bytes, with the limits above. The
 * bytes are copied: pdfjs moves the array it is given to its own worker.
 */
export function pdfDocumentParams(
  bytes: Uint8Array,
  opts: { password?: string } = {},
): DocumentInitParameters {
  return {
    data: new Uint8Array(bytes),
    ...(opts.password !== undefined ? { password: opts.password } : {}),
    ...(pdfjsAssets() ?? {}),
    maxImageSize: PDF_MAX_IMAGE_PIXELS,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
    useSystemFonts: true,
    verbosity: 0,
  };
}

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
export type PdfLoadingTask = ReturnType<Pdfjs['getDocument']>;

/** pdfjs itself, for its constants (`OPS`). */
export async function loadPdfjs(): Promise<Pdfjs> {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

/** Open the PDF. The caller destroys the returned task (`task.destroy()`),
 *  which owns pdfjs's worker, on every path. */
export async function openPdf(
  bytes: Uint8Array,
  opts: { password?: string } = {},
): Promise<PdfLoadingTask> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument(pdfDocumentParams(bytes, opts));
}
