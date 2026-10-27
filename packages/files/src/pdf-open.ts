/**
 * The one way this package opens a PDF with pdfjs: `withPdf`. Runs in the
 * parser service (server/parser) only, one job per process.
 *
 * pdfjs decodes an embedded image at its full declared size before anything
 * downstream can look at it, and the decoded pixels (plus the canvas a render
 * draws them on) live outside the V8 heap, so no JS-side check sees them
 * coming. A 747 KB PDF holding one 16000x16000 image peaked at ~1.9 GB in the
 * pictures pass and ~5.2 GB in the scanned-PDF render.
 *
 * The guarantee is the parser container: its OS memory limit kills the job
 * (the parser answers `crashed`), and the job's deadline kills a decode that
 * never settles (`timeout`). Inside it, two cheap bounds here:
 *
 *  - `maxImageSize` makes pdfjs drop an image whose dictionary DECLARES more
 *    than `PDF_MAX_IMAGE_PIXELS` before decoding it (it logs "Image exceeded
 *    maximum allowed size and was removed." and carries on), so the text
 *    layer and every normal picture on the page still come through. It is a
 *    check on the size the PDF declares, nothing more: a crafted file whose
 *    decoder output disagrees with its header (a JPEG whose own header is
 *    bigger, a huge soft mask) is bounded by the container alone.
 *  - A file over `PDF_MAX_BYTES` is refused before pdfjs sees it.
 *
 * (In the brain these were joined by a process-wide decode slot with wait and
 * hold deadlines; one job per process in a memory-limited container made them
 * unnecessary, and they are gone.)
 */

/**
 * The largest embedded image pdfjs will decode, in pixels (width x height, as
 * the image's dictionary declares them).
 *
 * 75 M keeps a 600 dpi scan readable, a real scanner setting: about 70 M
 * pixels for a 297 x 420 mm sheet, 35 M for A4 paper or US Letter. It is
 * also the largest round value whose render stays under a 1.2 GB rise, which
 * fits a job in the parser's default 2 GB limit.
 *
 * Measured on Linux, rendering a one-page scan holding one image, peak RSS
 * rise: 70 M +1.05 GB, 75 M +1.13 GB, 80 M +1.19 to +1.21 GB (Flate; JPEG is
 * lower, +0.87 GB at 75 M). The 16000x16000 case drops from ~1.9 GB to the baseline. The
 * pictures pass opens with a lower cap of its own (`MAX_IMAGE_PIXELS` in
 * pdf.ts, 30 M), so pdfjs never decodes an image there that the pass would
 * only throw away.
 */
export const PDF_MAX_IMAGE_PIXELS = 75_000_000;

/** The largest PDF any open accepts, in bytes. The old renderer
 *  (pdf-to-png-converter) refused past the same size. */
export const PDF_MAX_BYTES = 256 * 1024 * 1024;

/** pdfjs `getDocument` parameters every open in this package uses. */
export const SAFE_PDF_PARAMS = {
  maxImageSize: PDF_MAX_IMAGE_PIXELS,
  // pdfjs 6 no longer compiles PDF functions with `new Function`, so this is
  // a no-op there; it is kept so a pdfjs that still reads it never evaluates
  // code from a document.
  isEvalSupported: false,
  // Node has no FontFace; pdfjs already defaults this to true there. Explicit
  // so a change of default cannot start loading document fonts.
  disableFontFace: true,
} as const;

/**
 * The PDF is past a limit: too many bytes, or (from the rasterizer) every
 * page asked for too large to render. A verdict on the document, not a
 * failure of the machinery: trying again gives the same answer, so the
 * extractor records it as a terminal skip (`pdf_too_large`). Matched by
 * `name` (see `isPdfLimitError`) so a caller that loaded this module through
 * another import path still recognises it.
 */
export class PdfLimitError extends Error {
  override readonly name = 'PdfLimitError';
}

export function isPdfLimitError(err: unknown): err is PdfLimitError {
  return err instanceof Error && err.name === 'PdfLimitError';
}

// ─── declared image sizes ─────────────────────────────────────────────

/** How far around an `/Subtype /Image` the scan below looks for the rest of
 *  that image's dictionary. */
const DICT_WINDOW = 4096;

/** PDF delimiter or whitespace: what may follow a complete name. */
function endsName(byte: number | undefined): boolean {
  return byte === undefined || /[\s/<>[\]()%]/.test(String.fromCharCode(byte));
}

/** A direct integer value of `/key` in a dictionary's text; null when the
 *  key is missing or an indirect reference (`/Width 12 0 R`). */
function directInt(dict: string, key: string): number | null {
  const m = new RegExp(`/${key}\\s+(\\d+)(?![\\d.]|\\s+\\d+\\s+R)`).exec(dict);
  return m ? Number(m[1]) : null;
}

/** The object numbers the file names as soft masks (`/SMask 12 0 R`). */
function softMaskObjects(buf: Buffer): Set<number> {
  const out = new Set<number>();
  const needle = '/SMask';
  for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + needle.length)) {
    const m = /^\s*(\d+)\s+\d+\s+R/.exec(
      buf.toString('latin1', at + needle.length, at + needle.length + 32),
    );
    if (m) out.add(Number(m[1]));
  }
  return out;
}

/**
 * How many image XObjects in the file declare more pixels than `maxPixels`,
 * read from the raw bytes without parsing the document; counting stops at
 * `stopAt`. An image XObject is a stream and a stream is never stored inside
 * an object stream, so its dictionary sits in the file as plain text (also
 * when the file is encrypted: encryption covers strings and stream data, not
 * dictionary numbers). Only direct `/Width` and `/Height` values are read.
 *
 * An image that is another image's soft mask (an object a `/SMask n 0 R`
 * names: the alpha of a transparent photo) is not counted: it is never drawn
 * on its own, and counting it made a brochure with one big transparent photo
 * look like two oversize images, enough to be misread as a scan and lose its
 * figures.
 *
 * A cheap hint, not a verdict: a miss (an indirect size, an oversize inline
 * image) or an image declared but never drawn is possible, so callers use it
 * only to decide how hard to look, never to refuse a file.
 */
export function countOversizeImages(
  bytes: Uint8Array,
  maxPixels: number,
  stopAt = Number.POSITIVE_INFINITY,
): number {
  // A view on the same memory: no copy of a file that may be 256 MB.
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const masks = softMaskObjects(buf);
  const needle = '/Image';
  let found = 0;
  for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + needle.length)) {
    // `/ImageB`, `/ImageMask` and friends are other names.
    if (!endsName(buf[at + needle.length])) continue;
    if (!/\/Subtype\s*$/.test(buf.toString('latin1', Math.max(0, at - 32), at))) continue;
    const lo = Math.max(0, at - DICT_WINDOW);
    const objAt = buf.subarray(lo, at).lastIndexOf('obj');
    const from = objAt >= 0 ? lo + objAt : lo;
    if (objAt >= 0) {
      const header = /(\d+)\s+\d+\s+$/.exec(buf.toString('latin1', Math.max(lo, from - 24), from));
      if (header && masks.has(Number(header[1]))) continue;
    }
    const streamAt = buf.indexOf('stream', at);
    const to =
      streamAt >= 0 && streamAt - at <= DICT_WINDOW
        ? streamAt
        : Math.min(buf.length, at + DICT_WINDOW);
    const dict = buf.toString('latin1', from, to);
    const width = directInt(dict, 'Width');
    const height = directInt(dict, 'Height');
    if (width && height && width * height > maxPixels && ++found >= stopAt) break;
  }
  return found;
}

/**
 * Whether any image XObject in the file declares more than `maxPixels`
 * (default `PDF_MAX_IMAGE_PIXELS`), so pdfjs, opened with that cap, will drop
 * it from the operator list. The render reads each page's operator list
 * first when this is true (`drawsSomething` in rasterize.ts); a false
 * positive costs that extra list, a miss leaves the page rendered without the
 * image.
 */
export function declaresOversizeImage(
  bytes: Uint8Array,
  maxPixels: number = PDF_MAX_IMAGE_PIXELS,
): boolean {
  return countOversizeImages(bytes, maxPixels, 1) > 0;
}

// ─── opening ──────────────────────────────────────────────────────────

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type GetDocumentParams = Parameters<Pdfjs['getDocument']>[0] & object;
export type PdfDocument = Awaited<ReturnType<Pdfjs['getDocument']>['promise']>;

/** Extra `getDocument` parameters a caller may set. The safety parameters
 *  are not among them: they always win. */
export type OpenPdfOptions = Omit<
  Exclude<GetDocumentParams, string | URL | ArrayBuffer | Uint8Array>,
  'data' | 'url' | keyof typeof SAFE_PDF_PARAMS
>;

export type WithPdfOptions = OpenPdfOptions & {
  /** A lower image cap for this open (never above `PDF_MAX_IMAGE_PIXELS`). */
  maxImagePixels?: number;
};

/**
 * Open a PDF with the safe parameters, run `fn` on the loaded document, and
 * tear the loading task down (since pdfjs 6 the task, not the document, owns
 * the worker side) whatever happens.
 *
 * Throws `PdfLimitError` for a file over `PDF_MAX_BYTES`, and whatever pdfjs
 * throws loading the document (a wrong password, a corrupt file).
 */
export async function withPdf<T>(
  bytes: Uint8Array,
  opts: WithPdfOptions,
  fn: (pdf: { pdfjs: Pdfjs; doc: PdfDocument }) => Promise<T>,
): Promise<T> {
  // Refuse before copying: a 1 GB upload is not copied only to be refused.
  if (bytes.byteLength > PDF_MAX_BYTES) {
    throw new PdfLimitError(
      `PDF is ${Math.round(bytes.byteLength / (1024 * 1024))} MB; the limit is ${PDF_MAX_BYTES / (1024 * 1024)} MB`,
    );
  }
  const { maxImagePixels, ...params } = opts;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // The one copy, and a needed one: pdfjs refuses a Node Buffer and detaches
  // the array it is handed, while the caller keeps using its bytes.
  const data = new Uint8Array(bytes);
  const task = pdfjs.getDocument({
    ...params,
    data,
    ...SAFE_PDF_PARAMS,
    // Only ever lower: pdfjs reads -1 as "no limit", so anything not a
    // positive number keeps the package cap.
    maxImageSize:
      maxImagePixels && maxImagePixels > 0
        ? Math.min(maxImagePixels, PDF_MAX_IMAGE_PIXELS)
        : PDF_MAX_IMAGE_PIXELS,
  });
  try {
    return await task.promise.then((doc) => fn({ pdfjs, doc }));
  } finally {
    await task.destroy().catch(() => {});
  }
}
