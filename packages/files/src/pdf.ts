/**
 * PDF text + embedded-image extraction.
 *
 * `parsePdf` returns the embedded text layer via `pdf-parse`. Scanned-image
 * PDFs come back as '' (OCR is the extractor's separate rasterize path).
 * Encrypted PDFs and corrupt files throw; callers swallow the error and fall
 * back to the file's title so the extractor can still index *something*.
 *
 * `extractPdfImages` pulls the figures — the diagrams and screenshots a
 * manual is built around — out of the page content streams via pdfjs.
 *
 * Kept as a separate entry point (`@mantle/files/pdf`) so the heavy
 * `pdf-parse` dep is only loaded when a PDF actually shows up — the
 * rest of the files surface stays free of native bindings.
 */

import { PDFParse } from 'pdf-parse';
import { describeImageBytes, type EmbeddedImage } from './embedded-images';

export async function parsePdf(buf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return (result.text ?? '').trim();
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// ─── embedded images ──────────────────────────────────────────────────

/** Pages we'll scan for figures. The per-document image cap bounds the
 *  output; this bounds the *work* on a long document. */
const MAX_PDF_PAGES_SCANNED = 100;

/** Refuse to materialise an image beyond this many pixels. RGBA expansion is
 *  4 bytes a pixel, so 30 MP is already a 120 MB buffer — past this we're
 *  looking at a full-bleed scan, which the OCR path owns anyway. */
const MAX_IMAGE_PIXELS = 30_000_000;

/** pdfjs `ImageKind`. Only the two colour kinds are handled — see the note
 *  in `toPngBytes`. */
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

/** How long to wait for pdfjs to decode one image object before giving up on
 *  it. Bounds the worst case for a malformed XObject. */
const IMAGE_RESOLVE_TIMEOUT_MS = 15_000;

type PdfImageData = { width: number; height: number; kind?: number; data?: Uint8Array };

/**
 * Encode a decoded pdfjs image as PNG.
 *
 * Returns null for the 1-bit grayscale kind. That is a deliberate omission
 * rather than an oversight: pdfjs hands 1bpp back as packed bits whose
 * polarity depends on the image's Decode array, so getting it wrong yields a
 * *silently inverted* picture — white-on-black nonsense presented to the user
 * as a diagram. Bilevel content in PDFs is overwhelmingly scanned pages, which
 * the extractor's rasterize + OCR path already covers properly. Better to skip
 * it than to show something wrong.
 */
async function toPngBytes(img: PdfImageData): Promise<Buffer | null> {
  const { width, height, kind, data } = img;
  if (!data || !width || !height) return null;
  if (kind !== RGB_24BPP && kind !== RGBA_32BPP) return null;
  if (width * height > MAX_IMAGE_PIXELS) return null;

  const { createCanvas, ImageData } = await import('@napi-rs/canvas');
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (kind === RGBA_32BPP) {
    rgba.set(data.subarray(0, rgba.length));
  } else {
    // RGB → RGBA, opaque.
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      const o = i * 4;
      rgba[o] = data[j]!;
      rgba[o + 1] = data[j + 1]!;
      rgba[o + 2] = data[j + 2]!;
      rgba[o + 3] = 255;
    }
  }
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.toBuffer('image/png');
}

/** A figure caption on the page, when there is exactly one and it is
 *  unambiguous. PDFs carry no structure, so anything cleverer than this
 *  would be guesswork dressed up as metadata. */
function soleFigureCaption(lines: string[]): string | undefined {
  const hits = lines.filter((l) => /^\s*(figure|fig\.?|table|exhibit)\s*\d+\s*[:.\-–—]?/i.test(l));
  return hits.length === 1 ? hits[0]!.trim() : undefined;
}

/**
 * Every figure embedded in the PDF's pages, in page order.
 *
 * **Scanned documents are deliberately excluded.** When a PDF is a scan,
 * every page is a single full-bleed image, and extracting them would produce
 * a pile of "figures" that are really just pages — duplicating the OCR path
 * and burying any real content. We detect that shape (one image per page,
 * across the whole document) and return nothing, leaving scans to
 * `rasterizePdfToPngs` + the vision worker where they belong.
 */
export async function extractPdfImages(bytes: Buffer): Promise<EmbeddedImage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
  try {
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const doc = await loadingTask.promise;
    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES_SCANNED);

    type Candidate = { page: number; name: string };
    const candidates: Candidate[] = [];
    const perPageCount = new Map<number, number>();
    const captionByPage = new Map<number, string>();
    const pages = new Map<number, Awaited<ReturnType<typeof doc.getPage>>>();

    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      pages.set(p, page);
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        // Stencil masks (paintImageMaskXObject) are excluded — they're
        // clipping shapes, not pictures.
        if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintInlineImageXObject) {
          continue;
        }
        const name = ops.argsArray[i]?.[0];
        if (typeof name !== 'string') continue;
        candidates.push({ page: p, name });
        perPageCount.set(p, (perPageCount.get(p) ?? 0) + 1);
      }
      const text = await page.getTextContent();
      const lines = text.items.map((it) => ('str' in it ? it.str : '')).filter((s) => s.trim());
      const caption = soleFigureCaption(lines);
      if (caption) captionByPage.set(p, caption);
    }

    // Scanned-document shape: every scanned page carries exactly one image.
    const looksScanned =
      pageCount >= 2 &&
      candidates.length === pageCount &&
      [...perPageCount.values()].every((n) => n === 1);
    if (looksScanned) return [];

    const out: EmbeddedImage[] = [];
    for (const { page, name } of candidates) {
      const pageProxy = pages.get(page)!;
      // `objs.get(name, cb)` registers a listener and fires once the image is
      // decoded. Do NOT gate this on `objs.has(name)` — `has` reports whether
      // the object is ALREADY resolved, which for a freshly-walked operator
      // list is routinely false even though the callback would fire
      // immediately after (verified against pdfjs 6.1.200: `has` returned
      // false for an image `get` then resolved fine). Gating on it silently
      // extracts nothing.
      //
      // The timeout is the safety net that makes the callback form usable in
      // an ingest worker: a malformed XObject that never resolves would
      // otherwise wedge this promise — and with it the extract queue — for
      // ever.
      const raw = await new Promise<PdfImageData | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), IMAGE_RESOLVE_TIMEOUT_MS);
        const done = (v: PdfImageData | null) => {
          clearTimeout(timer);
          resolve(v);
        };
        try {
          pageProxy.objs.get(name, done);
        } catch {
          try {
            pageProxy.commonObjs.get(name, done);
          } catch {
            done(null);
          }
        }
      });
      if (!raw) continue;
      const png = await toPngBytes(raw).catch(() => null);
      if (!png || png.length === 0) continue;
      out.push({
        bytes: png,
        ordinal: out.length + 1,
        location: { page },
        caption: perPageCount.get(page) === 1 ? captionByPage.get(page) : undefined,
        ...describeImageBytes(png, 'png'),
      });
    }
    return out;
  } finally {
    await loadingTask?.destroy().catch(() => {});
  }
}
