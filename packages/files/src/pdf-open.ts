/**
 * The one way this package opens a PDF with pdfjs.
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
 * `maxImageSize` makes pdfjs drop such an image before decoding it (it logs
 * "Image exceeded maximum allowed size and was removed." and carries on), so
 * the text layer and every normal picture on the page still come through.
 *
 * Every pdfjs open in the package goes through here: `openPdf` for our own
 * `getDocument` calls, `SAFE_PDF_PARAMS` for pdf-parse, which takes the same
 * parameters and passes them to its own `getDocument`.
 */

/**
 * The largest embedded image pdfjs will decode, in pixels (width x height).
 *
 * 40 M keeps a 600 dpi scan of an A4 or US Letter page (about 35 M pixels)
 * readable, which is a real scanner setting, while bounding one decoded
 * image to roughly 40 M x 3 bytes of RGB plus pdfjs's working copies
 * (measured: the 16000x16000 case drops from ~1.9 GB to the baseline). The
 * pictures pass refuses anything past 30 M anyway (`MAX_IMAGE_PIXELS` in
 * pdf.ts), so it never keeps what this lets through and then throws away.
 */
export const PDF_MAX_IMAGE_PIXELS = 40_000_000;

/** pdfjs `getDocument` parameters every open in this package uses. */
export const SAFE_PDF_PARAMS = {
  maxImageSize: PDF_MAX_IMAGE_PIXELS,
  // pdfjs 6 no longer compiles PDF functions with `new Function`, so this is
  // a no-op there; it is kept so a pdfjs that still reads it (pdf-parse's CJS
  // bundle inlines a pdfjs 5) never evaluates code from a document.
  isEvalSupported: false,
  // Node has no FontFace; pdfjs already defaults this to true there. Explicit
  // so a change of default cannot start loading document fonts.
  disableFontFace: true,
} as const;

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type GetDocumentParams = Parameters<Pdfjs['getDocument']>[0] & object;

/** Extra `getDocument` parameters a caller may set. The safety parameters
 *  are not among them: they always win. */
export type OpenPdfOptions = Omit<
  Exclude<GetDocumentParams, string | URL | ArrayBuffer | Uint8Array>,
  'data' | 'url' | keyof typeof SAFE_PDF_PARAMS
>;

/**
 * Start loading a PDF with the safe parameters. Returns pdfjs itself (for
 * `OPS` and friends) and the loading task. The caller awaits `task.promise`
 * and MUST `await task.destroy()` in a `finally`: since pdfjs 6 the task, not
 * the document, owns the worker, and a skipped destroy leaks it.
 */
export async function openPdf(
  bytes: Uint8Array,
  opts: OpenPdfOptions = {},
): Promise<{ pdfjs: Pdfjs; task: ReturnType<Pdfjs['getDocument']> }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs transfers (detaches) the buffer it is handed; copy so the caller's
  // Buffer stays usable (the extractor reuses the same bytes for the next pass).
  const data = new Uint8Array(bytes);
  const task = pdfjs.getDocument({ ...opts, data, ...SAFE_PDF_PARAMS });
  return { pdfjs, task };
}
