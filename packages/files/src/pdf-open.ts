/**
 * The one way this package opens a PDF with pdfjs: `withPdf`.
 *
 * pdfjs decodes an embedded image at its full declared size before anything
 * downstream can look at it, and the decoded pixels (plus the canvas a render
 * draws them on) live outside the V8 heap, so no JS-side check sees them
 * coming. A 747 KB PDF holding one 16000x16000 image peaked at ~1.9 GB in the
 * pictures pass and ~5.2 GB in the scanned-PDF render (which also blocked the
 * event loop ~2 s); the api container is capped at 3 GB, so one upload could
 * OOM-kill it and the extract job's retry and the boot sweep would load the
 * same file again.
 *
 * Three bounds, all here:
 *
 *  - `maxImageSize` makes pdfjs drop an image whose dictionary DECLARES more
 *    than `PDF_MAX_IMAGE_PIXELS` before decoding it (it logs "Image exceeded
 *    maximum allowed size and was removed." and carries on), so the text
 *    layer and every normal picture on the page still come through. It is a
 *    check on the size the PDF declares, nothing more: a crafted file whose
 *    decoder output disagrees with its header (a JPEG whose own header is
 *    bigger, a huge soft mask) is not bounded by it. Those are bounded only by
 *    the planned parser sidecar, which runs the decode under an OS memory
 *    limit.
 *  - A file over `PDF_MAX_BYTES` is refused before pdfjs sees it.
 *  - One decode at a time per process: a `withPdf` that may decode images or
 *    draw (the default) holds a process-wide slot from `getDocument` until the
 *    loading task is destroyed, so two big documents never decode side by
 *    side. A caller that waits longer than its `waitMs` gets a `PdfBusyError`,
 *    which is retryable and never a verdict on the document.
 *
 * Text-only reads (`mode: 'text'`: the text layer, the page count, the
 * password probe) open through `withPdf` for the same parameters, size refusal
 * and teardown, but do NOT take the slot. pdfjs's text extraction skips image
 * XObjects and draws nothing, so their cost is the file itself (bounded by
 * `PDF_MAX_BYTES`), and making a chat attachment's text read queue behind a
 * hundred-page pictures pass would turn it into a timeout for no memory saved.
 */

/**
 * The largest embedded image pdfjs will decode, in pixels (width x height, as
 * the image's dictionary declares them).
 *
 * 75 M keeps a 600 dpi scan of an A3 page (about 70 M pixels) readable, and
 * an A4 or US Letter one (about 35 M) with room to spare: real scanner
 * settings. With one decode at a time, it is also the largest round value
 * whose render stays under a 1.2 GB rise in an api container capped at 3 GB.
 * Measured on Linux, rendering a one-page scan holding one image, peak RSS
 * rise: 70 M +1.05 GB, 75 M +1.13 GB, 80 M +1.19 to +1.21 GB (Flate; JPEG is
 * lower, +0.87 GB at 75 M), and two renders racing for the slot cost no more
 * than one. The 16000x16000 case drops from ~1.9 GB to the baseline. The
 * pictures pass opens with a lower cap of its own (`MAX_IMAGE_PIXELS` in
 * pdf.ts, 30 M), so pdfjs never decodes an image there that the pass would
 * only throw away.
 */
export const PDF_MAX_IMAGE_PIXELS = 75_000_000;

/** The largest PDF any open accepts, in bytes. The old renderer
 *  (pdf-to-png-converter) refused past the same size. */
export const PDF_MAX_BYTES = 256 * 1024 * 1024;

/** How long a decode waits for the slot by default. Sized for a background
 *  job (the extractor), which retries a `PdfBusyError`; a live chat turn
 *  passes `PDF_TURN_WAIT_MS` instead. */
export const PDF_JOB_WAIT_MS = 60_000;

/** How long a live chat turn waits for the slot before giving up. */
export const PDF_TURN_WAIT_MS = 15_000;

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

/**
 * Another PDF held the decode slot for longer than this caller would wait.
 * Says nothing about the document: retry it later.
 */
export class PdfBusyError extends Error {
  override readonly name = 'PdfBusyError';
}

export function isPdfBusyError(err: unknown): err is PdfBusyError {
  return err instanceof Error && err.name === 'PdfBusyError';
}

// ─── the decode slot ──────────────────────────────────────────────────

let slotHeld = false;
const slotWaiters: (() => void)[] = [];

/** Take the slot, waiting at most `waitMs`. Resolves to its release, which
 *  hands the slot straight to the next waiter (so a late arrival can never
 *  jump the queue) and is safe to call more than once. */
async function takeSlot(waitMs: number): Promise<() => void> {
  if (slotHeld) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const at = slotWaiters.indexOf(wake);
        if (at >= 0) slotWaiters.splice(at, 1);
        reject(
          new PdfBusyError(
            `another PDF is being decoded; gave up after waiting ${Math.round(waitMs / 1000)} s (retry later)`,
          ),
        );
      }, waitMs);
      slotWaiters.push(wake);
    });
  }
  slotHeld = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = slotWaiters.shift();
    if (next) next();
    else slotHeld = false;
  };
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
  /** `'decode'` (the default) for anything that may decode an image or draw:
   *  it holds the process-wide slot. `'text'` for a read of the text layer or
   *  page tree only: no slot. */
  mode?: 'decode' | 'text';
  /** How long a `'decode'` open waits for the slot before throwing a
   *  `PdfBusyError`. Default `PDF_JOB_WAIT_MS`. */
  waitMs?: number;
  /** A lower image cap for this open (never above `PDF_MAX_IMAGE_PIXELS`). */
  maxImagePixels?: number;
};

/**
 * Open a PDF with the safe parameters, run `fn` on the loaded document, and
 * tear the loading task down (since pdfjs 6 the task, not the document, owns
 * the worker side) whatever happens. A `'decode'` open holds the slot from
 * before `getDocument` until that teardown is done.
 *
 * Throws `PdfLimitError` for a file over `PDF_MAX_BYTES`, `PdfBusyError`
 * when the slot stays taken past `waitMs`, and whatever pdfjs throws loading
 * the document (a wrong password, a corrupt file).
 *
 * Never nest a `'decode'` open inside another's `fn`: the inner one would
 * wait on the slot its own caller holds.
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
  const { mode = 'decode', waitMs = PDF_JOB_WAIT_MS, maxImagePixels, ...params } = opts;
  const release = mode === 'decode' ? await takeSlot(waitMs) : null;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // The one copy, and a needed one: pdfjs refuses a Node Buffer and detaches
    // the array it is handed, while every caller keeps using its bytes (the
    // extractor reads the same Buffer for its next pass).
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
      const doc = await task.promise;
      return await fn({ pdfjs, doc });
    } finally {
      await task.destroy().catch(() => {});
    }
  } finally {
    release?.();
  }
}
