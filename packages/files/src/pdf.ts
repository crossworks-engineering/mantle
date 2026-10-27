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
import {
  describeImageBytes,
  MAX_EMBEDDED_IMAGES_PER_DOC,
  passesGate,
  type EmbeddedImage,
} from './embedded-images';
import { countOversizeImages, type PdfDocument, withPdf } from './pdf-open';

/** pdf-parse (v2) ends every page with a `-- N of M --` marker line, text or
 *  no text. */
const PAGE_MARKER_LINE = /^[ \t]*-- \d+ of \d+ --[ \t]*$/gm;

export async function parsePdf(buf: Buffer): Promise<string> {
  // A text-only read (see pdf-open.ts), so no decode slot. pdf-parse is
  // handed the document `withPdf` opened rather than opening its own: its
  // `load()` reuses a document already set on the parser, and its own
  // `destroy()` calls `doc.destroy()`, which pdfjs 6 removed, so a parser
  // left to tear itself down leaked its worker-side document on every call.
  // `withPdf` destroys the loading task instead. Verbosity 0 (errors only) is
  // pdf-parse's own default.
  return withPdf(buf, { mode: 'text', verbosity: 0 }, async ({ doc }) => {
    const parser = new PDFParse({ data: new Uint8Array(0) });
    (parser as unknown as { doc: typeof doc }).doc = doc;
    const result = await parser.getText();
    const text = (result.text ?? '').trim();
    // A scan has no text layer, but its markers are still there: a 1-page
    // scan came back as `-- 1 of 1 --` (12 chars, so `body_too_short` and no
    // OCR), and a longer one cleared the 20-char minimum and was indexed as
    // its own page markers. Markers and nothing else is no text layer: return
    // '' so the extractor takes the OCR path, as the header above promises.
    // A PDF with real text keeps its markers (page boundaries) unchanged.
    return text.replace(PAGE_MARKER_LINE, '').trim() ? text : '';
  });
}

/** Page count of a PDF, or null when pdfjs cannot open it (corrupt,
 *  encrypted, over the size limit). Reads the page tree only: no text, no
 *  rendering, so no decode slot. Used to price an OCR pass before it runs
 *  (maintain `ocr-rescan`). */
export async function pdfPageCount(bytes: Buffer): Promise<number | null> {
  try {
    return await withPdf(bytes, { mode: 'text', useSystemFonts: true }, async ({ doc }) => {
      return doc.numPages;
    });
  } catch {
    return null;
  }
}

// ─── embedded images ──────────────────────────────────────────────────

/** Pages we'll scan for figures. The per-document image cap bounds the
 *  output; this bounds the *work* on a long document. */
const MAX_PDF_PAGES_SCANNED = 100;

/** Refuse to materialise an image beyond this many pixels. RGBA expansion is
 *  4 bytes a pixel, so 30 MP is already a 120 MB buffer — past this we're
 *  looking at a full-bleed scan, which the OCR path owns anyway. The pass
 *  opens the document with this as pdfjs's own image cap, so a bigger image
 *  is dropped before it is decoded, not decoded and then refused. */
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
  const png = canvas.toBuffer('image/png');
  // Let go of the canvas's pixels now rather than whenever the GC gets to it.
  canvas.width = 0;
  return png;
}

/** A figure caption on the page, when there is exactly one and it is
 *  unambiguous. PDFs carry no structure, so anything cleverer than this
 *  would be guesswork dressed up as metadata. */
function soleFigureCaption(lines: string[]): string | undefined {
  const hits = lines.filter((l) => /^\s*(figure|fig\.?|table|exhibit)\s*\d+\s*[:.\-–—]?/i.test(l));
  return hits.length === 1 ? hits[0]!.trim() : undefined;
}

type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;

/**
 * The decoded data of one image the operator list names, or null if it never
 * arrives. pdfjs keeps an image it caches across pages in the document-wide
 * store (`commonObjs`, ids starting `g_`) and every other one in the page's
 * own (`objs`); asking the wrong store with a callback never throws, it just
 * waits for ever, so the store is picked by id the way pdfjs's own canvas
 * does. Do NOT gate this on `has(name)`: that reports whether the object is
 * ALREADY resolved, which right after the operator list is routinely false
 * though the callback fires a moment later.
 *
 * The timeout is the safety net that makes the callback form usable in an
 * ingest worker: a malformed XObject that never resolves would otherwise
 * wedge this promise, and with it the extract queue, for ever.
 */
function resolveImage(page: PdfPage, name: string): Promise<PdfImageData | null> {
  const store = name.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), IMAGE_RESOLVE_TIMEOUT_MS);
    const done = (v: PdfImageData | null) => {
      clearTimeout(timer);
      resolve(v ?? null);
    };
    try {
      store.get(name, done as (data: unknown) => void);
    } catch {
      done(null);
    }
  });
}

/**
 * Every figure embedded in the PDF's pages, in page order.
 *
 * **Scanned documents are deliberately excluded.** When a PDF is a scan,
 * every page is a single full-bleed image, and extracting them would produce
 * a pile of "figures" that are really just pages — duplicating the OCR path
 * and burying any real content. We detect that shape (one image per page,
 * across every page read) and return nothing, leaving scans to
 * `rasterizePdfToPngs` + the vision worker where they belong.
 *
 * **One page at a time.** pdfjs keeps a page's decoded images until that page
 * is cleaned up, so the pass reads a page's operator list, fetches and
 * encodes that page's images, cleans the page up, and only then moves on:
 * what is alive at once is one page's pictures plus the PNGs kept so far,
 * never the whole document's pixels. The order matters: every image fetched
 * is awaited before `cleanup()` (which clears the page's objects, so a fetch
 * still pending would wait out its timeout), and an image the pass skips may
 * finish decoding after the cleanup, which pdfjs then drops.
 *
 * While every page read so far holds exactly one image the document may be a
 * scan, so those pages are only counted, not fetched: a scan then costs one
 * operator list a page and no encoding. The first page that breaks the shape
 * sends the pass back over the deferred pages (reading each again, in order)
 * before it carries on, so the output is exactly what reading every page
 * fully would give.
 *
 * A scan page whose image is over this pass's cap reads as NO image: pdfjs
 * drops it from the operator list. Left at that, one such page would break
 * the shape and hand the scan's other pages out as figures (one vision call
 * each). So a page with no image still counts as scan-shaped while the file
 * declares an over-cap image not yet accounted for: at most one such page per
 * over-cap image the bytes declare (`countOversizeImages`), so a document of
 * text pages and one big photo still breaks the shape at its second textual
 * page.
 *
 * It stops once `maxImages` images have passed the gate (the caller's
 * per-document cap; decorations do not count toward it), so a long document
 * is not decoded past what will be kept. Holds the process-wide decode slot
 * (`withPdf`), waiting at most `waitMs` for it.
 */
export async function extractPdfImages(
  bytes: Buffer,
  opts?: { maxImages?: number; waitMs?: number },
): Promise<EmbeddedImage[]> {
  const maxImages = Math.max(0, opts?.maxImages ?? MAX_EMBEDDED_IMAGES_PER_DOC);
  return withPdf(
    bytes,
    { useSystemFonts: true, maxImagePixels: MAX_IMAGE_PIXELS, waitMs: opts?.waitMs },
    async ({ pdfjs, doc }) => {
      const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES_SCANNED);
      const out: EmbeddedImage[] = [];
      const seen = new Set<string>();
      let kept = 0;

      /** Read page `p`: count its image candidates and, when `fetch`, turn
       *  them into PNGs. Cleans the page up before returning, whatever
       *  happens. Returns the candidate count. */
      const readPage = async (p: number, fetch: boolean): Promise<number> => {
        const page = await doc.getPage(p);
        try {
          const ops = await page.getOperatorList();
          let candidates = 0;
          const wanted: string[] = [];
          for (let i = 0; i < ops.fnArray.length; i++) {
            const fn = ops.fnArray[i];
            // Stencil masks (paintImageMaskXObject) are excluded — they're
            // clipping shapes, not pictures.
            if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintInlineImageXObject) {
              continue;
            }
            // [name, width, height] for an XObject, the size as its
            // dictionary declares it; an inline image carries its data
            // instead of a name and is not a candidate.
            const [name, width, height] = (ops.argsArray[i] ?? []) as unknown[];
            if (typeof name !== 'string') continue;
            candidates++;
            // Never fetch what `toPngBytes` would refuse. pdfjs's own cap for
            // this pass already dropped such an image, so this only guards a
            // size pdfjs did not check.
            if (typeof width === 'number' && typeof height === 'number') {
              if (width * height > MAX_IMAGE_PIXELS) continue;
            }
            wanted.push(name);
          }
          if (!fetch) return candidates;

          // A caption is only ever attached to a page's sole picture.
          let caption: string | undefined;
          if (candidates === 1 && wanted.length === 1) {
            const text = await page.getTextContent();
            const lines = text.items
              .map((it) => ('str' in it ? it.str : ''))
              .filter((t) => t.trim());
            caption = soleFigureCaption(lines);
          }

          for (const name of wanted) {
            if (kept >= maxImages) break;
            const raw = await resolveImage(page, name);
            if (!raw) continue;
            const png = await toPngBytes(raw).catch(() => null);
            if (!png || png.length === 0) continue;
            const img: EmbeddedImage = {
              bytes: png,
              ordinal: out.length + 1,
              location: { page: p },
              caption,
              ...describeImageBytes(png, 'png'),
            };
            out.push(img);
            // The caller gates again (and owns the counts it reports); this
            // only decides when enough real pictures are in hand to stop.
            if (passesGate(img, seen).keep) {
              seen.add(img.sha256);
              kept++;
            }
          }
          return candidates;
        } finally {
          page.cleanup();
        }
      };

      // Pages read while the document is still scan-shaped (one image on
      // every page so far), counted but not yet fetched.
      let deferred: number[] | null = pageCount >= 2 ? [] : null;
      // Pages with no image that may each be a scan page whose image pdfjs
      // dropped (see above). Read inside `withPdf`, after its size refusal.
      let droppedLeft = deferred
        ? countOversizeImages(bytes, MAX_IMAGE_PIXELS, MAX_PDF_PAGES_SCANNED)
        : 0;
      for (let p = 1; p <= pageCount && kept < maxImages; p++) {
        if (!deferred) {
          await readPage(p, true);
          continue;
        }
        const candidates = await readPage(p, false);
        if (candidates === 1 || (candidates === 0 && droppedLeft-- > 0)) {
          deferred.push(p);
          continue;
        }
        // Not a scan after all: fetch what was deferred, then this page.
        const earlier = deferred;
        deferred = null;
        for (const d of earlier) {
          if (kept >= maxImages) break;
          await readPage(d, true);
        }
        if (kept < maxImages) await readPage(p, true);
      }
      // Every page held exactly one image: a scan, left to the OCR path.
      return deferred ? [] : out;
    },
  );
}
