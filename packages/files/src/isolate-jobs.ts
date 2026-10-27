/**
 * The reads ./isolate.ts runs in a worker thread, by name. Each calls the
 * in-process half of its reader, never a dispatcher (which would hand the
 * read to another thread). Arguments and results cross the thread by
 * structured clone, so they are plain data: Buffers, strings, numbers.
 *
 * A zip-based document is inflated part by part under the caps in
 * ./zip-guard.ts before its library (mammoth, exceljs) opens it, so the
 * library's own inflate holds no more than was measured.
 */

import { DocumentLimitError } from './document-limit';

/** Characters of text one read may return. Sixteen times what the extractor
 *  stores (TEXT_STORE_MAX_CHARS, 1,000,000), so no real document loses
 *  anything it would have kept; past it is a file that unpacks to far more
 *  text than it holds (an 800 KB spreadsheet that renders 77 MB of table). */
export const MAX_READ_TEXT_CHARS = 16_000_000;

function capped(text: string): string {
  if (text.length <= MAX_READ_TEXT_CHARS) return text;
  throw new DocumentLimitError(
    'too_large',
    `The document unpacks to ${text.length.toLocaleString('en-US')} characters of text, past the ${MAX_READ_TEXT_CHARS.toLocaleString('en-US')} a document read may return.`,
  );
}

/** True for the zip magic, `PK\x03\x04`. */
function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32BE(0) === 0x504b0304;
}

/** Every part inflated once under the caps; the real sizes. */
async function guarded(bytes: Buffer): Promise<Map<string, number>> {
  return (await import('./zip-guard')).assertZipWithinLimits(bytes);
}

const JOBS = {
  pdfText: async (bytes: Buffer) => capped(await (await import('./pdf')).parsePdf(bytes)),
  docxText: async (bytes: Buffer) => {
    await guarded(bytes);
    return capped(await (await import('./docx')).parseDocx(bytes));
  },
  xlsxText: async (bytes: Buffer) => {
    const read = await (await import('./xlsx')).xlsxTextInProcess(bytes, await guarded(bytes));
    return 'text' in read ? { text: capped(read.text) } : read;
  },
  pptxText: async (bytes: Buffer) => capped(await (await import('./pptx')).parsePptx(bytes)),
  sheetGrid: async (bytes: Buffer) =>
    (await import('./sheet-to-grid')).parseSheetToGrid(
      bytes,
      isZip(bytes) ? await guarded(bytes) : undefined,
    ),
  anydocMarkdown: async (bytes: Buffer, ext: string) =>
    capped(await (await import('./anydoc')).anydocMarkdownInProcess(bytes, ext)),
  legacySheet: async (bytes: Buffer) =>
    (await import('./legacy-sheet')).legacySheetInProcess(bytes),
  legacySheetFromXhtml: async (xhtml: string) =>
    (await import('./legacy-sheet')).legacySheetFromXhtmlInProcess(xhtml),
  vsdx: async (bytes: Buffer) => capped(await (await import('./vsdx')).parseVsdxInProcess(bytes)),
  markup: async (bytes: Buffer, ext: string) =>
    capped((await import('./markup')).parseMarkupBytes(bytes, ext)),
  images: async (bytes: Buffer, ext: string, maxImages: number) => {
    if (ext === 'docx') await guarded(bytes);
    return (await import('./embedded-images')).extractEmbeddedImagesInProcess(
      bytes,
      ext,
      maxImages,
    );
  },
};

export type JobName = keyof typeof JOBS;
export type JobArgs<K extends JobName> = Parameters<(typeof JOBS)[K]>;
export type JobResult<K extends JobName> = Awaited<ReturnType<(typeof JOBS)[K]>>;

export async function runJob(job: string, args: unknown[]): Promise<unknown> {
  if (!Object.hasOwn(JOBS, job)) throw new Error(`no document read named ${job}`);
  const fn = JOBS[job as JobName] as (...a: unknown[]) => Promise<unknown>;
  try {
    return await fn(...args);
  } catch (err) {
    // A string or buffer past V8's own maximum (a zip part whose directory
    // lied about its size can get there inside the heap limit): the same
    // verdict as running out of heap.
    if (err instanceof RangeError && /string length|allocation failed|buffer/i.test(err.message)) {
      throw new DocumentLimitError(
        'memory',
        `Reading the file needed more memory than a document read may use (${err.message}).`,
      );
    }
    throw err;
  }
}
