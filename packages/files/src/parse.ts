/**
 * Document → plain text, dispatched by extension. The single place that knows
 * which parser handles which format, shared by the extractor (durable index)
 * and the conversational attachment helper (live answer) so document handling
 * stays identical wherever a file enters.
 *
 * Three-tier dispatch:
 *   1. In-process parsers (fast, no network) — pdf-parse, mammoth, SheetJS,
 *      and the UTF-8 read for text files. Throws on a parser failure
 *      (encrypted / corrupt) so callers can tell a real failure apart from a
 *      genuinely-empty file.
 *   2. Apache Tika fallback (self-hosted docker service) — for everything
 *      else our in-process parsers can't handle: .odt / .ods / .odp / .pptx
 *      / .ppt / .doc / .rtf / .epub / .vsdx / .vsd plus the long tail Tika
 *      supports. Tika
 *      is **never-throws**: any failure (service down, timeout, unsupported
 *      bytes) returns '' so we degrade cleanly. See ./tika.ts.
 *   3. Returns '' for an extension we don't try to extract text from at all
 *      (images go through the vision path; truly opaque binaries fall
 *      through). Caller (the extractor) treats '' as the honest
 *      "no_text_layer" skip.
 */

import { TEXT_EXTS, TIKA_EXTS, mimeForExt } from './slug';

export async function parseDocumentBytes(bytes: Buffer, ext: string): Promise<string> {
  if (ext === 'pdf') return (await import('./pdf')).parsePdf(bytes);
  if (ext === 'docx') return (await import('./docx')).parseDocx(bytes);
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'xlsb')
    return (await import('./xlsx')).parseXlsx(bytes);
  if (TEXT_EXTS.has(ext)) return bytes.toString('utf8');
  // Tier 2 — anything else Tika might know how to parse. Lazy import keeps
  // the fetch + AbortController machinery off the cold path for the common
  // case (in-process parsers handle ~95% of uploads). Tika's wrapper is
  // never-throws → '' on every failure mode.
  if (TIKA_EXTS.has(ext)) {
    return (await import('./tika')).parseTikaBytes(bytes, { mimeType: mimeForExt(ext) });
  }
  return '';
}
