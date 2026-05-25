/**
 * PDF → PNG rasterization for the OCR fallback.
 *
 * A scanned / image-only PDF has no text layer, so `parseDocumentBytes`
 * (pdf-parse) yields nothing. The extractor renders its pages to PNG here and
 * runs each through the vision worker (OCR) — the same path images already
 * take. Pure Node: `pdf-to-png-converter` wraps pdfjs + `@napi-rs/canvas`
 * (prebuilt native binaries), no system packages required.
 *
 * Kept as a separate entry point (`@mantle/files/rasterize`) with the heavy dep
 * behind a dynamic import, so it's only loaded when a textless PDF actually
 * shows up — mirroring how `./pdf` keeps pdf-parse off the hot path, and
 * keeping the native dep out of the Next.js (apps/web) module graph.
 */

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
 * Render up to `maxPages` pages of a PDF to PNG buffers. `viewportScale` 2
 * roughly doubles resolution for cleaner OCR. Throws on an unrenderable /
 * corrupt PDF — callers wrap this in a trace step and treat a throw or an empty
 * result as "couldn't OCR".
 */
export async function rasterizePdfToPngs(
  bytes: Buffer,
  opts?: { maxPages?: number; viewportScale?: number },
): Promise<RasterPage[]> {
  const maxPages = Math.max(1, opts?.maxPages ?? DEFAULT_MAX_OCR_PAGES);
  const { pdfToPng } = await import('pdf-to-png-converter');
  const pages = await pdfToPng(bytes, {
    viewportScale: opts?.viewportScale ?? 2.0,
    // 1-based page numbers; cap to bound cost. Pages beyond the document's
    // length are silently ignored by the converter.
    pagesToProcess: Array.from({ length: maxPages }, (_, i) => i + 1),
    verbosityLevel: 0,
  });
  const out: RasterPage[] = [];
  for (const p of pages) {
    if (p.content) out.push({ pageNumber: p.pageNumber, png: p.content });
  }
  return out;
}
