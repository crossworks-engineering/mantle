/**
 * Zip-based documents (.docx, .xlsx, .pptx, OpenDocument, .vsdx, .xlsb)
 * opened with a cap on what each part may inflate to.
 *
 * A zip's directory says how big each part is, and it can lie: a 6 KB file
 * whose one part claims 1 KB and inflates to gigabytes. JSZip and the
 * libraries built on it (mammoth, exceljs) inflate a part whole before they
 * check anything. So every part is inflated here first with Node's zlib and
 * an output cap (`maxOutputLength`): a part past
 * {@link MAX_ZIP_ENTRY_BYTES}, or a file past {@link MAX_ZIP_TOTAL_BYTES}
 * altogether, stops at the cap and the read ends as a
 * {@link DocumentTooLargeError}. Only a file that passes goes on to its reader,
 * whose own inflate then holds no more than was measured. The readers in
 * this package that open the zip themselves (.pptx, pictures, Visio, .xlsb)
 * read every part through {@link loadZip}, which applies the same caps as
 * it goes.
 *
 * The caps mirror anydoc's own (128 MB a part, 512 MB a file): far past any
 * real document (XML compresses about ten to one). This is a cheap early
 * refusal, run only inside the parser service; the parser container's memory
 * limit is the guarantee behind it.
 */

import zlib from 'node:zlib';
import type JSZipType from 'jszip';
import { DocumentTooLargeError } from './read-limit';

/** Bytes one part of a zip may inflate to. */
export const MAX_ZIP_ENTRY_BYTES = 128 * 1024 * 1024;
/** Bytes all the parts of one zip may inflate to together. */
export const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024;
/** Parts one zip may hold. */
export const MAX_ZIP_ENTRIES = 100_000;

export type ZipLimits = { maxEntryBytes?: number; maxTotalBytes?: number };

type Compressed = {
  compression?: { magic?: string } | null;
  compressedContent?: Uint8Array;
  compressedSize?: number;
  uncompressedSize?: number;
};

function compressedOf(entry: JSZipType.JSZipObject): Compressed | null {
  return ((entry as unknown as { _data?: Compressed })._data ?? null) as Compressed | null;
}

const STORE = '\x00\x00';
const DEFLATE = '\x08\x00';

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/**
 * One part's bytes, inflated with the cap. `budget` is what the file has
 * left; a part past either throws a {@link DocumentTooLargeError}. A method
 * other than stored or deflated (which JSZip cannot read either) returns
 * null.
 */
function inflateCapped(
  path: string,
  entry: JSZipType.JSZipObject,
  maxEntry: number,
  budget: number,
): Buffer | null {
  const data = compressedOf(entry);
  // JSZip's private `_data` is what lets a part be measured before anything
  // inflates it. Gone (a JSZip that changed its insides), the guard would
  // measure nothing and pass every bomb: fail closed instead
  // (zip-guard.test.ts pins it).
  if (!data) throw new Error(`the zip guard cannot read part ${path}: JSZip has no _data`);
  const content = data.compressedContent;
  if (!content) return null;
  const cap = Math.min(maxEntry, budget);
  const magic = data.compression?.magic;
  if (magic === STORE) {
    if (content.byteLength > cap) throw tooLarge(path, content.byteLength, maxEntry, budget);
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  }
  if (magic !== DEFLATE) return null;
  try {
    return zlib.inflateRawSync(content, { maxOutputLength: Math.max(1, cap) });
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw tooLarge(path, cap + 1, maxEntry, budget);
    }
    // Corrupt deflate data: the reader's own inflate fails the same way and
    // reports it; nothing was allocated past the cap.
    return null;
  }
}

function tooLarge(path: string, size: number, maxEntry: number, budget: number): Error {
  return size > maxEntry
    ? new DocumentTooLargeError(
        `The file's part ${path} unpacks to more than ${mb(maxEntry)}, past what one part of a document may.`,
      )
    : new DocumentTooLargeError(
        `The file unpacks to more than ${mb(budget)} more than it may (${path} and the parts before it).`,
      );
}

async function jszip(bytes: Buffer): Promise<JSZipType> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  if (Object.keys(zip.files).length > MAX_ZIP_ENTRIES) {
    throw new DocumentTooLargeError(
      `The file holds more than ${MAX_ZIP_ENTRIES.toLocaleString('en-US')} parts.`,
    );
  }
  return zip;
}

/**
 * Inflate every part of the zip once, under the caps, and throw a
 * {@link DocumentTooLargeError} at the first part past them. Returns each
 * part's real inflated size. Throws whatever JSZip throws for bytes that are
 * not a zip.
 */
export async function assertZipWithinLimits(
  bytes: Buffer,
  limits: ZipLimits = {},
): Promise<Map<string, number>> {
  const maxEntry = limits.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
  let budget = limits.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;
  const zip = await jszip(bytes);
  const sizes = new Map<string, number>();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const out = inflateCapped(path, entry, maxEntry, budget);
    const size = out?.byteLength ?? 0;
    budget -= size;
    sizes.set(path, size);
  }
  return sizes;
}

/** One part of a {@link Zip}: its declared size (from the directory, which
 *  can lie) and its bytes, read under the caps. */
export type ZipEntry = {
  readonly declaredSize: number | null;
  async(kind: 'string'): Promise<string>;
  async(kind: 'uint8array'): Promise<Uint8Array>;
};

/** A zip opened for reading part by part, every part under the caps. */
export type Zip = {
  /** Every path in the archive (directories included, as JSZip lists them). */
  readonly files: Readonly<Record<string, { readonly dir: boolean }>>;
  file(path: string): ZipEntry | null;
};

/**
 * Open a zip whose parts are read through the caps: each part counts against
 * the file's total once, and is kept once read (a logo placed on sixty
 * slides is inflated once). Throws whatever JSZip throws for bytes that are
 * not a zip, and a {@link DocumentTooLargeError} when a part read is past a cap.
 */
export async function loadZip(bytes: Buffer, limits: ZipLimits = {}): Promise<Zip> {
  const maxEntry = limits.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
  let budget = limits.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;
  const zip = await jszip(bytes);
  const seen = new Map<string, Buffer>();
  const read = (path: string, entry: JSZipType.JSZipObject): Buffer => {
    const kept = seen.get(path);
    if (kept) return kept;
    const out = inflateCapped(path, entry, maxEntry, budget);
    if (!out) throw new Error(`unreadable zip part ${path}`);
    budget -= out.byteLength;
    seen.set(path, out);
    return out;
  };
  return {
    files: zip.files,
    file(path: string): ZipEntry | null {
      const entry = zip.file(path);
      if (!entry || entry.dir) return null;
      const declared = compressedOf(entry)?.uncompressedSize;
      return {
        declaredSize: typeof declared === 'number' && Number.isFinite(declared) ? declared : null,
        async(kind: 'string' | 'uint8array'): Promise<never> {
          // A refusal is a rejected promise, as JSZip's own `async` gives.
          return Promise.resolve().then(() => {
            const out = read(path, entry);
            return (kind === 'string' ? out.toString('utf8') : out) as never;
          });
        },
      } as ZipEntry;
    },
  };
}
