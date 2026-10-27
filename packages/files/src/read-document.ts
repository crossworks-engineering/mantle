/**
 * Document → plain text, dispatched by extension: the parser service's text
 * read (server/parser, route POST /text). The single place that knows which
 * reader handles which format. The brain never imports it: it asks the
 * parser through the parser client (`parseDocumentBytes` in ./parse.ts).
 *
 * Every reader here reads untrusted bytes, so this module runs only inside
 * the parser container, one job per process, under the container's memory
 * limit and the job's time limit. Cheap early refusals (a zip part past its
 * inflate cap, a sheet past its cell budget) throw a DocumentTooLargeError
 * (./read-limit.ts), which the parser answers as `too_large`.
 *
 * Throws on a reader failure (encrypted / corrupt) so the caller can tell a
 * real failure apart from a genuinely-empty file, and an
 * {@link UnsupportedFormatError} for an extension no reader here takes.
 * Returns '' for a readable document with no text (a scan, an empty sheet):
 * the caller treats '' as the honest "no_text_layer" skip.
 */

import { assertZipWithinLimits } from './zip-guard';
import { ANYDOC_EXTS, LEGACY_SHEET_EXTS, MARKUP_EXTS, TEXT_EXTS } from './slug';

/** No reader in the parser takes this extension. */
export class UnsupportedFormatError extends Error {
  readonly code = 'unsupported' as const;
  constructor(ext: string) {
    super(`no reader for .${ext || 'unknown'} files`);
    this.name = 'UnsupportedFormatError';
  }
}

/** The zip-based formats: each part is inflated once under the caps
 *  (./zip-guard.ts) before a reader that inflates parts whole sees it. */
const ZIP_EXTS = new Set(['docx', 'xlsx', 'xlsm', 'pptx', 'odt', 'ods', 'odp', 'epub', 'vsdx']);

function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32BE(0) === 0x504b0304;
}

/** A legacy workbook's text: converted, then read as an `.xlsx`. A sheet
 *  refused for its size is named in a closing note, so the index says what
 *  is missing. Not converted at all: ''. */
async function legacySheetText(bytes: Buffer): Promise<string> {
  const { convertLegacySheetToXlsx, describeRefused, MAX_LEGACY_CELLS } =
    await import('./legacy-sheet');
  const converted = await convertLegacySheetToXlsx(bytes);
  if (!converted) return '';
  const text = await (await import('./xlsx')).parseXlsx(converted.xlsx);
  if (converted.refused.length === 0) return text;
  const note = `[Left out for size: ${describeRefused(converted.refused)}, past the ${MAX_LEGACY_CELLS.toLocaleString('en-US')}-cell limit for a legacy spreadsheet.]`;
  return text ? `${text}\n\n${note}` : note;
}

export async function readDocumentText(bytes: Buffer, ext: string): Promise<string> {
  const e = ext.toLowerCase();
  if (TEXT_EXTS.has(e)) return bytes.toString('utf8');
  if (ZIP_EXTS.has(e) && isZip(bytes)) await assertZipWithinLimits(bytes);
  if (e === 'pdf') return (await import('./pdf')).parsePdf(bytes);
  if (e === 'docx') return (await import('./docx')).parseDocx(bytes);
  // PowerPoint: our own reader keeps slide order. A deck it cannot open, or
  // one it reads as empty, gets anydoc.
  if (e === 'pptx') {
    const text = await (await import('./pptx')).parsePptx(bytes).catch(async (err: unknown) => {
      const { isDocumentTooLarge } = await import('./read-limit');
      if (isDocumentTooLarge(err)) throw err;
      return '';
    });
    if (text) return text;
    return (await import('./anydoc')).parseAnydocBytes(bytes, e);
  }
  if (e === 'xlsx' || e === 'xlsm') return (await import('./xlsx')).parseXlsx(bytes);
  // exceljs reads OOXML only, so the legacy binaries are CONVERTED to .xlsx
  // (via anydoc, ./legacy-sheet.ts) and then take the modern path.
  if (LEGACY_SHEET_EXTS.has(e)) {
    if (isZip(bytes)) await assertZipWithinLimits(bytes);
    return legacySheetText(bytes);
  }
  // Autodesk DWF plot sets: container parse → sheets/layers/labels digest.
  // Content-gated: a file named `.dwf` that lacks the DWF magic (usually a
  // renamed DWFx, an OPC zip) returns '' and takes the extractor's honest
  // hollow skip. Throws on a corrupt container.
  if (e === 'dwf') {
    const { sniffDwf, parseDwf } = await import('./dwf');
    if (!sniffDwf(bytes)) return '';
    return parseDwf(bytes);
  }
  // `.xml` is a container, not a format: only a document that is actually
  // MSPDI gets the plan renderer. A file that sniffs as a plan but yields no
  // rows drops to the generic markup read rather than returning '': worst
  // case the upload is a searchable document, never silently nothing.
  if (e === 'xml') {
    const { sniffMspdi, renderMspdiText } = await import('./mspdi');
    if (sniffMspdi(bytes)) {
      const plan = renderMspdiText(bytes);
      if (plan) return plan;
    }
  }
  if (MARKUP_EXTS.has(e)) return (await import('./markup')).parseMarkupBytes(bytes, e);
  if (e === 'vsdx') return (await import('./vsdx')).parseVsdx(bytes);
  if (ANYDOC_EXTS.has(e)) return (await import('./anydoc')).parseAnydocBytes(bytes, e);
  throw new UnsupportedFormatError(e);
}
