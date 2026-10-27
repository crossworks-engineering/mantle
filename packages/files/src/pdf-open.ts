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
 * 75 M keeps a 600 dpi scan readable, a real scanner setting: about 70 M
 * pixels for a 297 x 420 mm sheet, 35 M for A4 paper or US Letter. With one
 * decode at a time, it is also the largest round value whose render stays
 * under a 1.2 GB rise in an api container capped at 3 GB.
 *
 * That rise fits. Peak memory measured on every fleet box on 2026-10-27
 * (cgroup `memory.peak`, about one day since the last roll): mantle_api
 * 449 to 783 MiB against a 3 GiB limit (4 GiB on one box), mantle_web 580 to
 * 932 MiB against 3 GiB (6 GiB on one box). The ~1.46 GB in the api's
 * mem_limit comment (docker-compose.yml) is where the old 1.5g cap OOMed in
 * 2026-09, not normal load: a worst render (+1.13 GB) on top of the highest
 * measured peak is about 1.9 GB, still well under 3 GiB.
 *
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
 *  job (the extractor), which retries a `PdfBusyError`: a few long holders
 *  in a row (each bounded by `PDF_MAX_HOLD_MS`), and still well under the
 *  job's 60-minute expiry. A live chat turn passes `PDF_TURN_WAIT_MS`
 *  instead. */
export const PDF_JOB_WAIT_MS = 10 * 60_000;

/** How long a live chat turn waits for the slot before giving up. */
export const PDF_TURN_WAIT_MS = 15_000;

/** The longest a `'decode'` open may hold the slot. Past it the loading task
 *  is destroyed, the slot is released and the open throws a `PdfBusyError`,
 *  so a document whose decode never settles cannot wedge every PDF behind
 *  it; its job fails and is retried like any other busy slot. */
export const PDF_MAX_HOLD_MS = 5 * 60_000;

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
 * Another PDF held the decode slot for longer than this caller would wait,
 * or this decode held it past `PDF_MAX_HOLD_MS` and was stopped. Retryable:
 * the extractor fails the job (pg-boss retries it) rather than recording a
 * verdict on the document.
 */
export class PdfBusyError extends Error {
  override readonly name = 'PdfBusyError';
}

export function isPdfBusyError(err: unknown): err is PdfBusyError {
  return err instanceof Error && err.name === 'PdfBusyError';
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

/**
 * How many image XObjects in the file declare more pixels than `maxPixels`,
 * read from the raw bytes without parsing the document; counting stops at
 * `stopAt`. An image XObject is a stream and a stream is never stored inside
 * an object stream, so its dictionary sits in the file as plain text (also
 * when the file is encrypted: encryption covers strings and stream data, not
 * dictionary numbers). Only direct `/Width` and `/Height` values are read.
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
  const needle = '/Image';
  let found = 0;
  for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + needle.length)) {
    // `/ImageB`, `/ImageMask` and friends are other names.
    if (!endsName(buf[at + needle.length])) continue;
    if (!/\/Subtype\s*$/.test(buf.toString('latin1', Math.max(0, at - 32), at))) continue;
    const lo = Math.max(0, at - DICT_WINDOW);
    const objAt = buf.subarray(lo, at).lastIndexOf('obj');
    const from = objAt >= 0 ? lo + objAt : lo;
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
  /** How long a `'decode'` open may hold the slot. Default
   *  `PDF_MAX_HOLD_MS`; only tests pass anything else. */
  holdMs?: number;
};

/**
 * Open a PDF with the safe parameters, run `fn` on the loaded document, and
 * tear the loading task down (since pdfjs 6 the task, not the document, owns
 * the worker side) whatever happens. A `'decode'` open holds the slot from
 * before `getDocument` until that teardown is done.
 *
 * Throws `PdfLimitError` for a file over `PDF_MAX_BYTES`, `PdfBusyError`
 * when the slot stays taken past `waitMs` or this open holds it past
 * `holdMs`, and whatever pdfjs throws loading the document (a wrong
 * password, a corrupt file). A timed-out `fn` is not awaited: the task is
 * destroyed under it, so its next pdfjs call fails, and the slot moves on.
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
  const {
    mode = 'decode',
    waitMs = PDF_JOB_WAIT_MS,
    holdMs = PDF_MAX_HOLD_MS,
    maxImagePixels,
    ...params
  } = opts;
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
    const work = task.promise.then((doc) => fn({ pdfjs, doc }));
    if (!release) {
      try {
        return await work;
      } finally {
        await task.destroy().catch(() => {});
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new PdfBusyError(
              `PDF decode ran past ${Math.round(holdMs / 1000)} s and was stopped (retry later)`,
            ),
          ),
        holdMs,
      );
    });
    try {
      // `race` subscribes to `work`, so a rejection after the deadline won
      // is handled, not an unhandled rejection.
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
      await task.destroy().catch(() => {});
    }
  } finally {
    release?.();
  }
}
