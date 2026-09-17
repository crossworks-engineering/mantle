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
  // Spreadsheets. exceljs reads OOXML only, so the legacy binaries are
  // CONVERTED to .xlsx at the door (via Tika — see ./legacy-sheet.ts) and then
  // take the identical path as a modern workbook. One reader, one set of caps,
  // one output shape. A conversion that fails falls through to Tika's plain
  // text, which is still a searchable document rather than nothing.
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'xlsb') {
    const { isLegacySheetExt, convertLegacySheetToXlsx } = await import('./legacy-sheet');
    if (isLegacySheetExt(ext)) {
      const converted = await convertLegacySheetToXlsx(bytes, mimeForExt(ext));
      if (!converted)
        return (await import('./tika')).parseTikaBytes(bytes, { mimeType: mimeForExt(ext) });
      return (await import('./xlsx')).parseXlsx(converted);
    }
    return (await import('./xlsx')).parseXlsx(bytes);
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
  // plan but yields no rows (truncated, a dialect we mis-read) drops to Tika
  // rather than returning ''. Worst case the upload is a searchable document;
  // it is never silently nothing, which is the failure this whole path exists
  // to prevent.
  if (ext === 'xml') {
    const { sniffMspdi, renderMspdiText } = await import('./mspdi');
    if (sniffMspdi(bytes)) {
      const plan = renderMspdiText(bytes);
      if (plan) return plan;
    }
  }
  // Tier 2 — anything else Tika might know how to parse. Lazy import keeps
  // the fetch + AbortController machinery off the cold path for the common
  // case (in-process parsers handle ~95% of uploads). Tika's wrapper is
  // never-throws → '' on every failure mode.
  if (TIKA_EXTS.has(ext)) {
    return (await import('./tika')).parseTikaBytes(bytes, { mimeType: mimeForExt(ext) });
  }
  return '';
}
