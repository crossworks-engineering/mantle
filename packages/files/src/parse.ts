/**
 * Document → plain text, dispatched by extension. The single place that knows
 * which parser handles which format, shared by the extractor (durable index)
 * and the conversational attachment helper (live answer) so document handling
 * stays identical wherever a file enters.
 *
 * Three-tier dispatch:
 *   1. In-process parsers (fast, no network): pdf-parse, mammoth, exceljs,
 *      our .pptx and .vsdx readers, anydoc (legacy Office, OpenDocument,
 *      RTF, EPUB), the markup reader (HTML, XML), and the UTF-8 read for
 *      text files. Throws on a parser failure (encrypted / corrupt) so
 *      callers can tell a real failure apart from a genuinely-empty file.
 *      Every one of them but the UTF-8 read (and the DWG and DXF readers
 *      below, which hand the file to the media sidecar) runs in a worker
 *      thread with
 *      a heap and time limit (./isolate.ts), a zip-based file inflated
 *      under per-part caps first (./zip-guard.ts): nothing an upload holds
 *      runs on the server's own heap or event loop. A document stopped by a
 *      limit throws a DocumentLimitError, which the extractor records as a
 *      terminal skip with the reason; a read that could not run in time (a
 *      busy box, a first time-out) throws a DocumentReadRetryableError,
 *      which is retried.
 *   2. Apache Tika, an OPT-IN add-on (the `tika` compose profile): the only
 *      reader for .vsd, and the second try for a file anydoc cannot read.
 *      Tika is **never-throws**: any failure (service off or down, timeout,
 *      unsupported bytes) returns '' so we degrade cleanly. See ./tika.ts.
 *   3. Returns '' for an extension we don't try to extract text from at all
 *      (images go through the vision path; truly opaque binaries fall
 *      through). Caller (the extractor) treats '' as the honest
 *      "no_text_layer" skip.
 */

import { DocumentLimitError, isDocumentLimitError, isRetryableReadError } from './document-limit';
import type { JobArgs, JobName, JobResult } from './isolate-jobs';
import { ANYDOC_EXTS, MARKUP_EXTS, TEXT_EXTS, TIKA_EXTS, mimeForExt } from './slug';

async function isolated<K extends JobName>(job: K, args: JobArgs<K>): Promise<JobResult<K>> {
  return (await import('./isolate')).runIsolated(job, args);
}

/** A workbook's text from exceljs in a worker thread; past exceljs's size
 *  ceiling, Tika's when the box runs it, else the refusal. */
async function xlsxText(bytes: Buffer): Promise<string> {
  const read = await isolated('xlsxText', [bytes]);
  if ('text' in read) return read.text;
  const { tikaConfigured, parseTikaBytes } = await import('./tika');
  const text = tikaConfigured()
    ? await parseTikaBytes(bytes, { mimeType: mimeForExt('xlsx') })
    : '';
  if (text) return text;
  throw new DocumentLimitError('too_large', `The workbook is too large to read: ${read.tooLarge}.`);
}

/** anydoc first; when it fails or reads nothing, Tika if the box runs it.
 *  Without Tika, anydoc's own failure is the answer (it throws, so the
 *  extractor records a real error rather than an empty document). A size
 *  limit, or a read that could not run in time, that Tika cannot read past
 *  either stays the answer, so its reason is recorded (or the job retried)
 *  rather than an empty document. */
async function anydocThenTika(bytes: Buffer, ext: string): Promise<string> {
  const { tikaConfigured, parseTikaBytes } = await import('./tika');
  let failure: unknown = null;
  try {
    const text = await (await import('./anydoc')).parseAnydocBytes(bytes, ext);
    if (text) return text;
  } catch (err) {
    failure = err;
  }
  if (tikaConfigured()) {
    const text = await parseTikaBytes(bytes, { mimeType: mimeForExt(ext) });
    if (text || !(isDocumentLimitError(failure) || isRetryableReadError(failure))) return text;
  }
  if (failure) throw failure;
  return '';
}

/** A legacy workbook's text: converted (./legacy-sheet.ts), then read as an
 *  `.xlsx`. A sheet refused for its size is named in a closing note, so the
 *  index says what is missing; when nothing else was read, the refusal is
 *  the answer. Not converted at all: Tika's plain text when on, else ''. */
async function legacySheetText(bytes: Buffer, ext: string): Promise<string> {
  const { convertLegacySheetToXlsx, describeRefused, MAX_LEGACY_CELLS } =
    await import('./legacy-sheet');
  const converted = await convertLegacySheetToXlsx(bytes, mimeForExt(ext));
  if (!converted) {
    return (await import('./tika')).parseTikaBytes(bytes, { mimeType: mimeForExt(ext) });
  }
  const text = await xlsxText(converted.xlsx);
  if (converted.refused.length === 0) return text;
  const note = `[Left out for size: ${describeRefused(converted.refused)}, past the ${MAX_LEGACY_CELLS.toLocaleString('en-US')}-cell limit for a legacy spreadsheet.]`;
  return text ? `${text}\n\n${note}` : note;
}

export async function parseDocumentBytes(bytes: Buffer, ext: string): Promise<string> {
  if (ext === 'pdf') return isolated('pdfText', [bytes]);
  if (ext === 'docx') return isolated('docxText', [bytes]);
  // PowerPoint: our own reader keeps slide order (Tika 4 shuffles it, see
  // ./pptx.ts). A deck it cannot open, or one it reads as empty, gets anydoc,
  // then Tika when the box runs it. A deck stopped by a limit, or a read that
  // could not run in time, is that answer: anydoc would only meet it again.
  if (ext === 'pptx') {
    const text = await isolated('pptxText', [bytes]).catch((err: unknown) => {
      if (isDocumentLimitError(err) || isRetryableReadError(err)) throw err;
      return '';
    });
    if (text) return text;
    return anydocThenTika(bytes, ext);
  }
  // Spreadsheets. exceljs reads OOXML only, so the legacy binaries are
  // CONVERTED to .xlsx at the door (via anydoc, see ./legacy-sheet.ts) and
  // then take the identical path as a modern workbook. One reader, one set of
  // caps, one output shape. A conversion that fails falls through to Tika's
  // plain text when the box runs Tika, else ''.
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'xlsb') {
    const { isLegacySheetExt } = await import('./legacy-sheet');
    if (isLegacySheetExt(ext)) return legacySheetText(bytes, ext);
    return xlsxText(bytes);
  }
  if (TEXT_EXTS.has(ext)) return bytes.toString('utf8');
  // Autodesk DWF plot sets: in-process container parse → sheets/layers/labels
  // digest (see ./dwf.ts). Content-gated like the MSPDI branch below — a file
  // named `.dwf` that lacks the DWF magic (usually a renamed DWFx, an OPC zip)
  // must not parse to a junk digest, so it returns '' and takes the extractor's
  // honest hollow skip (isHollowFilenameBody carves the 'dwf' route in for
  // exactly this). Throws on a corrupt container; returns '' for a DWF with no
  // 2D sheets (3D eModel). Tika has no DWF handler — no fallback tier.
  if (ext === 'dwf') {
    const { sniffDwf, parseDwf } = await import('./dwf');
    if (!sniffDwf(bytes)) return '';
    return parseDwf(bytes);
  }
  // AutoCAD DWG: the one routed format with NO local parser — the digest
  // comes from the media sidecar's converter chain (see ./dwg.ts). Sniff
  // miss returns '' (hollow skip, same carve-out as dwf); a missing or
  // failing sidecar THROWS so the extract records an honest error and a
  // re-queue after enabling the CAD tier heals the node.
  if (ext === 'dwg') {
    const { sniffDwg, parseDwg } = await import('./dwg');
    if (!sniffDwg(bytes)) return '';
    return parseDwg(bytes);
  }
  // AutoCAD DXF: the DWG interchange twin, same sidecar exchange (the worker
  // reads a DXF natively — converter "none") and the same contract: '' on a
  // sniff miss (hollow skip), THROW when the sidecar is missing or fails.
  // ASCII DXF is text but must never take the utf8 tier — raw group codes
  // index as garbage, which is why 'dxf' stays out of TEXT_EXTS.
  if (ext === 'dxf') {
    const { sniffDxf, parseDxf } = await import('./dxf');
    if (!sniffDxf(bytes)) return '';
    return parseDxf(bytes);
  }
  // `.xml` is a container, not a format — routing by extension alone would send
  // a Project plan through a generic text parser and lose every task name. So
  // this one branches on CONTENT: sniff the root element, and only a document
  // that is actually MSPDI gets the plan renderer.
  //
  // The fall-through is deliberate and load-bearing. A file that sniffs as a
  // plan but yields no rows (truncated, a dialect we mis-read) drops to the
  // generic markup read rather than returning ''. Worst case the upload is a
  // searchable document; it is never silently nothing, which is the failure
  // this whole path exists to prevent.
  if (ext === 'xml') {
    const { sniffMspdi, readMspdiText } = await import('./mspdi');
    if (sniffMspdi(bytes)) {
      const plan = await readMspdiText(bytes);
      if (plan) return plan;
    }
  }
  if (MARKUP_EXTS.has(ext)) return isolated('markup', [bytes, ext]);
  if (ext === 'vsdx') return (await import('./vsdx')).parseVsdx(bytes);
  if (ANYDOC_EXTS.has(ext)) return anydocThenTika(bytes, ext);
  // Tier 2: what only Tika reads. Lazy import keeps the fetch +
  // AbortController machinery off the cold path. Tika's wrapper is
  // never-throws → '' on every failure mode, and at once when it is off.
  if (TIKA_EXTS.has(ext)) {
    return (await import('./tika')).parseTikaBytes(bytes, { mimeType: mimeForExt(ext) });
  }
  return '';
}
