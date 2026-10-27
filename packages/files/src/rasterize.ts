/**
 * PDF → PNG rasterization for the OCR fallback.
 *
 * A scanned / image-only PDF has no text layer, so `parseDocumentBytes`
 * (pdf-parse) yields nothing. The extractor renders its pages to PNG here and
 * runs each through the vision worker (OCR), the same path images already
 * take. Pure Node: pdfjs draws onto an `@napi-rs/canvas` canvas (prebuilt
 * native binaries), no system packages required.
 *
 * Bounded on every axis that can blow the process up: the document is opened
 * through `withPdf`, so pdfjs drops an embedded image that declares more than
 * `PDF_MAX_IMAGE_PIXELS` instead of decoding it, and each page's canvas is
 * held to
 * `MAX_RENDER_PIXELS` by lowering that page's scale. One page renders at a
 * time, so one canvas is alive at a time.
 *
 * A page whose only content was such an image is not rendered: with the image
 * dropped it would come out blank and be read as a blank scan. It counts as
 * too large, like a page past the canvas cap. (A page with other content
 * beside the dropped image still renders, without it.)
 *
 * Runs in the parser service (server/parser) only, whose container memory
 * limit and job deadline stand behind these bounds.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import {
  declaresOversizeImage,
  isPdfLimitError,
  PDF_MAX_IMAGE_PIXELS,
  PdfLimitError,
  withPdf,
} from './pdf-open';

export { declaresOversizeImage, isPdfLimitError, PdfLimitError };

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

/** A page whose PNG is larger than this is sent as JPEG instead (a dense
 *  scan or photo page: PNG is the wrong format for it, and the answer
 *  carries every page in memory). */
export const PAGE_PNG_MAX_BYTES = 12 * 1024 * 1024;

export type RasterPage = {
  /** 1-based page number within the PDF. */
  pageNumber: number;
  /** The rendered page's encoded bytes: PNG, or JPEG when `mime` says so. */
  png: Buffer;
  mime: 'image/png' | 'image/jpeg';
};

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

/** The `getDocument` settings a render uses: those of the previous renderer
 *  (pdf-to-png-converter), so a normal page renders to the same pixels. A
 *  function because the asset paths are resolved at call time. */
function renderParams() {
  return {
    ...pdfjsAssetUrls(),
    cMapPacked: true,
    useSystemFonts: false,
    enableXfa: true,
    verbosity: 0,
  };
}

/** pdfjs operators that put something on the page: image paints, painted
 *  paths, shadings and text. Looked up by name so a renamed operator drops
 *  out rather than matching the wrong one. */
const DRAWING_OP_NAMES = [
  'paintImageXObject',
  'paintInlineImageXObject',
  'paintInlineImageXObjectGroup',
  'paintImageXObjectRepeat',
  'paintImageMaskXObject',
  'paintImageMaskXObjectGroup',
  'paintImageMaskXObjectRepeat',
  'paintSolidColorImageMask',
  'shadingFill',
  'showText',
  'showSpacedText',
  'nextLineShowText',
  'nextLineSetSpacingShowText',
] as const;

type OperatorList = { fnArray: number[]; argsArray: unknown[] };

/**
 * Whether a page's operator list draws anything. pdfjs drops an over-cap
 * image and carries on without saying so where a caller can see it (even in
 * strict mode its operator list and render resolve with what was built), so
 * a page whose only content was such an image is a list that draws nothing:
 * rendered, it is a blank canvas that OCR files as a blank scan. A path
 * counts when it is painted; a clip-only path (`re W n`, pdfjs's `endPath`)
 * draws nothing.
 */
function drawsSomething(ops: OperatorList, OPS: Record<string, number>): boolean {
  const drawing = new Set(
    DRAWING_OP_NAMES.map((n) => OPS[n]).filter((v): v is number => typeof v === 'number'),
  );
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]!;
    if (drawing.has(fn)) return true;
    if (fn === OPS.constructPath) {
      const paint = (ops.argsArray[i] as unknown[] | undefined)?.[0];
      if (paint !== OPS.endPath) return true;
    }
  }
  return false;
}

/**
 * Render up to `maxPages` pages of a PDF to PNG buffers. `viewportScale` 2
 * roughly doubles resolution for cleaner OCR; a page too big for
 * `MAX_RENDER_PIXELS` at that scale renders at the largest scale that fits.
 * Throws on an unrenderable / corrupt PDF, a `PdfLimitError` when the file is
 * over `PDF_MAX_BYTES` or every page asked for was too large to render (past
 * the canvas cap, or holding an image past `PDF_MAX_IMAGE_PIXELS`). Callers
 * wrap this in a trace step and treat a throw or an empty result as
 * "couldn't OCR".
 */
export async function rasterizePdfToPngs(
  bytes: Buffer,
  opts?: {
    maxPages?: number;
    viewportScale?: number;
    /** All pages' encoded bytes together: the page that would pass it, and
     *  every page after, is not rendered (`onBudget` hears how many). */
    maxTotalBytes?: number;
    onBudget?: (pagesLeftOut: number) => void;
  },
): Promise<RasterPage[]> {
  const maxPages = Math.max(1, opts?.maxPages ?? DEFAULT_MAX_OCR_PAGES);
  const wanted = opts?.viewportScale ?? 2.0;
  const { createCanvas } = await import('@napi-rs/canvas');
  return withPdf(bytes, renderParams(), async ({ pdfjs, doc }) => {
    // Only a file that declares an over-cap image pays for the extra operator
    // list below; every other PDF renders exactly as before. Read here, after
    // `withPdf` has refused a file over `PDF_MAX_BYTES`, so such a file is
    // never scanned.
    const mayDropImages = declaresOversizeImage(bytes);
    const count = Math.min(doc.numPages, maxPages);
    const out: RasterPage[] = [];
    const tooLarge: string[] = [];
    let total = 0;
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
        if (
          mayDropImages &&
          !drawsSomething(
            await page.getOperatorList(),
            pdfjs.OPS as unknown as Record<string, number>,
          )
        ) {
          tooLarge.push(
            `page ${pageNumber} draws nothing once an embedded image over ${PDF_MAX_IMAGE_PIXELS} pixels is dropped`,
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
        let encoded = await canvas.encode('png');
        let mime: RasterPage['mime'] = 'image/png';
        if (encoded.length > PAGE_PNG_MAX_BYTES) {
          encoded = await canvas.encode('jpeg', 85);
          mime = 'image/jpeg';
        }
        // Let go of the page's pixels now rather than whenever the GC
        // gets to the canvas.
        canvas.width = 0;
        if (opts?.maxTotalBytes !== undefined && total + encoded.length > opts.maxTotalBytes) {
          opts.onBudget?.(count - pageNumber + 1);
          break;
        }
        total += encoded.length;
        out.push({ pageNumber, png: encoded, mime });
      } finally {
        page.cleanup();
      }
    }
    if (out.length === 0 && tooLarge.length > 0) {
      throw new PdfLimitError(
        `PDF pages too large to render (${tooLarge.join('; ')}); the limits are ${MAX_RENDER_PIXELS} pixels a page and ${PDF_MAX_IMAGE_PIXELS} pixels an embedded image`,
      );
    }
    return out;
  });
}
