/**
 * Legacy spreadsheet → modern `.xlsx`, converted at the door.
 *
 * exceljs reads OOXML only: `.xlsx` and `.xlsm`. It cannot read the old binary
 * formats — BIFF `.xls` (Excel 97-2003) or `.xlsb`. SheetJS could, and that
 * auto-detection was the one capability we lost by dropping it.
 *
 * Rather than keep a second spreadsheet engine alive for two formats, we
 * CONVERT them on ingest: legacy bytes in, real `.xlsx` bytes out, and from
 * that point the whole system has exactly one spreadsheet reader. `./parse.ts`
 * and `./sheet-to-grid.ts` both run the converted buffer through the ordinary
 * exceljs path, so legacy files get the same caps, the same cell coercion and
 * the same output shape as anything else — no parallel code path to keep in
 * step.
 *
 * ## The converter is anydoc, with Tika as the opt-in second try
 *
 * anydoc (./anydoc.ts) reads BIFF and `.xlsb` in-process and gives each sheet
 * as a heading and a table, which we rebuild as a workbook with exceljs. A
 * file anydoc cannot read goes to Tika (Apache POI underneath) on a box that
 * runs the Tika add-on: we ask for its XHTML rendering (one
 * `<div class="page">` per sheet, with an `<h1>` sheet name and a `<table>` of
 * `<tr>`/`<td>`) and rebuild that the same way.
 *
 * ## What conversion costs, honestly
 *
 * Both readers give a RENDERING, not the cell model, so type fidelity is
 * reduced. Tika's XHTML:
 *
 *   - **Booleans are dropped.** A `TRUE`/`FALSE` cell renders as an empty
 *     `<td/>`. Column alignment survives (verified — the placeholder cell is
 *     still emitted), so nothing shifts; the value is simply lost.
 *   - **Dates arrive as display text** ("1/15/26"), not as date cells, so
 *     downstream type inference will usually call such a column text.
 *   - Numbers survive as numeric-looking text and re-infer cleanly.
 *
 * That is a real loss and it is why this path is reserved for the two formats
 * that cannot be read any other way. It is also, in practice, theoretical:
 * across three production brains there is not a single `.xls` or
 * `.xlsb` (the largest spreadsheet corpus is 60 `.xlsx` + 13 `.xlsm`). If a real
 * one ever lands, this comment is the record of exactly what degrades.
 *
 * ## Size: refused before anything is built, and read off the main thread
 *
 * A rendering is a full rectangle. A workbook holding only A1 and GR10000
 * renders as 10,000 x 200 cells, almost all empty, and rebuilding that with
 * exceljs took 18.7 s and 1.39 GB on the server's own thread. So:
 *
 *   - a file that is really OOXML (an `.xlsx` renamed `.xls`, which Excel
 *     itself opens without complaint) is not converted at all: it goes to
 *     the ordinary exceljs path, which reads only the cells present and
 *     has its own caps;
 *   - every sheet is measured from its own cell records before anydoc sees
 *     the file (./sheet-extent.ts: never from the extent the file declares,
 *     which can lie), and a workbook past {@link MAX_LEGACY_CELLS} is
 *     refused, naming the sheets; one that cannot be measured is not given
 *     to anydoc at all. anydoc reads a container rebuilt from exactly the
 *     parts measured, not the upload;
 *   - each laid-out sheet is checked against the budget again before a row
 *     is copied out (see {@link LegacyConversion});
 *   - the anydoc read and the rebuild run in a worker thread with a heap and
 *     time limit (./isolate.ts);
 *   - one upload converts once: the text pass and the auto-table pass share
 *     the conversion of the same bytes (anydoc's sheet reader carries no
 *     pictures, so the picture pass does not read a legacy sheet at all;
 *     Tika does, when on).
 *
 * Unreadable bytes, Tika down, no tables in the output: `null`, and the
 * caller degrades to whatever it would have done for an unreadable file. A
 * size limit throws a {@link DocumentLimitError} instead, so the reason is
 * recorded rather than looking like an unreadable file.
 */

import ExcelJS from 'exceljs';
import { SaxesParser } from 'saxes';
import type { RefusedSheet } from './anydoc';
import { DocumentLimitError, isDocumentLimitError, isRetryableReadError } from './document-limit';
import type { SheetExtent } from './sheet-extent';
import { LEGACY_SHEET_EXTS } from './slug';
import { parseTikaBytes, tikaConfigured } from './tika';

/** Cells (rows x widest row, empty ones included) a legacy workbook may
 *  rebuild to, over all its sheets. 1,000,000 is 1,000 rows x 1,000 columns
 *  or 100,000 x 10: past the 5,000-row text cap (./xlsx.ts) and past what
 *  a person reviews as a table, and inside the read's heap limit with room
 *  to spare (exceljs takes about 200 bytes a cell). */
export const MAX_LEGACY_CELLS = 1_000_000;

/** A converted workbook, and the sheets left out of it for their size. */
export type LegacyConversion = { xlsx: Buffer; refused: RefusedSheet[] };

/** True when the bytes are an OOXML workbook (`.xlsx`/`.xlsm`): a zip whose
 *  directory names `xl/workbook.xml`. An `.xlsb` is a zip too, but its
 *  workbook part is `xl/workbook.bin`, so it is not matched. */
export function isOoxmlWorkbook(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04 &&
    bytes.includes('xl/workbook.xml')
  );
}

/** One line per refused sheet, for the note and the skip reason. */
export function describeRefused(refused: RefusedSheet[]): string {
  return refused
    .map(
      (r) =>
        `sheet "${r.name}" (${r.rows.toLocaleString('en-US')} rows x ${r.cols.toLocaleString('en-US')} columns)`,
    )
    .join(', ');
}

function refusedError(refused: RefusedSheet[]): DocumentLimitError {
  return new DocumentLimitError(
    'too_large',
    `The workbook is too large to read: ${describeRefused(refused)} ${refused.length === 1 ? 'is' : 'are'} past the ${MAX_LEGACY_CELLS.toLocaleString('en-US')}-cell limit for a legacy spreadsheet. Save it as .xlsx to read it in full.`,
  );
}

/** True when this extension needs converting before the exceljs path. */
export function isLegacySheetExt(ext: string): boolean {
  return LEGACY_SHEET_EXTS.has(ext.toLowerCase());
}

/** One sheet lifted out of Tika's XHTML: a name and a rectangle of strings. */
type LegacySheet = { name: string; rows: string[][] };

/** Keep the sheets that fit the cell budget, in order; refuse the rest. */
function withinBudget(
  sheets: LegacySheet[],
  refused: RefusedSheet[] = [],
): { kept: LegacySheet[]; refused: RefusedSheet[] } {
  let budget = MAX_LEGACY_CELLS;
  const kept: LegacySheet[] = [];
  const out = [...refused];
  for (const sheet of sheets) {
    let cols = 0;
    for (const row of sheet.rows) cols = Math.max(cols, row.length);
    const cells = sheet.rows.length * cols;
    if (cells > budget) {
      out.push({ name: sheet.name, rows: sheet.rows.length, cols });
      continue;
    }
    budget -= cells;
    kept.push(sheet);
  }
  return { kept, refused: out };
}

/**
 * Strip Tika's `<head>` and any control-character references.
 *
 * Tika emits the workbook's own metadata into `<head>`, and a real `.xls`
 * written by SheetJS produced `<title>&#0;</title>` — a NUL character
 * reference, which is not legal XML and which a strict parser (saxes) rejects
 * outright. The `<body>` is well-formed; the junk is confined to metadata we
 * do not want. So we take the body and neutralise stray control references
 * rather than trying to parse the document whole.
 */
function bodyXml(xhtml: string): string | null {
  const open = xhtml.indexOf('<body');
  if (open === -1) return null;
  const start = xhtml.indexOf('>', open);
  const end = xhtml.lastIndexOf('</body>');
  if (start === -1 || end === -1 || end <= start) return null;
  const inner = xhtml.slice(start + 1, end);
  // Drop numeric refs to C0 controls (except tab/LF/CR, which are legal).
  return `<body>${inner.replace(/&#x?0*(?:[0-8bcefBCEF]|1[0-9a-fA-F]);/g, '')}</body>`;
}

/**
 * Pull `{ sheet name, rows }` out of Tika's spreadsheet XHTML.
 *
 * Shape Tika produces per sheet:
 *   `<div class="page"><h1>Orders</h1><table><tbody><tr><td>…</td>…</tr>…`
 *
 * The `<h1>` is optional in principle, so sheets fall back to positional
 * names. Returns `[]` if the markup does not parse or holds no tables.
 */
function sheetsFromXhtml(xhtml: string): LegacySheet[] {
  const body = bodyXml(xhtml);
  if (!body) return [];

  const sheets: LegacySheet[] = [];
  let pendingName: string | null = null;
  let rows: string[][] | null = null;
  let row: string[] | null = null;
  let cell: string | null = null;
  let inHeading = false;
  let heading = '';

  const flush = () => {
    if (rows && rows.length > 0) {
      sheets.push({ name: pendingName ?? `Sheet${sheets.length + 1}`, rows });
    }
    rows = null;
    pendingName = null;
  };

  const parser = new SaxesParser({ fragment: false });
  parser.on('opentag', (node) => {
    switch (node.name) {
      case 'h1':
        inHeading = true;
        heading = '';
        break;
      case 'table':
        // A second <table> in the same page div starts a new sheet rather
        // than silently merging into the previous one.
        if (rows) flush();
        rows = [];
        break;
      case 'tr':
        if (rows) row = [];
        break;
      case 'td':
      case 'th':
        if (row) cell = '';
        break;
    }
  });
  parser.on('text', (t) => {
    if (inHeading) heading += t;
    else if (cell !== null) cell += t;
  });
  parser.on('closetag', (node) => {
    switch (node.name) {
      case 'h1':
        inHeading = false;
        // The heading names the sheet whose table comes NEXT, so a table
        // already open belongs to the previous heading — close it first.
        if (rows) flush();
        pendingName = heading.trim() || null;
        break;
      case 'td':
      case 'th':
        if (row && cell !== null) row.push(cell.trim());
        cell = null;
        break;
      case 'tr':
        if (rows && row) rows.push(row);
        row = null;
        break;
      case 'table':
        flush();
        break;
    }
  });

  try {
    parser.write(body).close();
  } catch {
    // Partial parse: keep whatever complete tables we already collected.
    flush();
  }
  return sheets.filter((s) => s.rows.some((r) => r.some((c) => c !== '')));
}

/** Drop the sheets with no text in any cell. */
function nonEmpty(sheets: LegacySheet[]): LegacySheet[] {
  return sheets.filter((s) => s.rows.some((r) => r.some((c) => c !== '')));
}

/** Rebuild the kept sheets as an `.xlsx`; `null` when none is left. Throws
 *  the size refusal when sheets were read but every one was refused. */
async function rebuild(
  kept: LegacySheet[],
  refused: RefusedSheet[],
): Promise<LegacyConversion | null> {
  if (kept.length === 0) {
    if (refused.length > 0) throw refusedError(refused);
    return null;
  }
  const wb = new ExcelJS.Workbook();
  for (const sheet of kept) {
    // Excel caps sheet names at 31 chars and forbids \ / ? * [ ] :
    const name = (sheet.name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet';
    const ws = wb.addWorksheet(name);
    for (const row of sheet.rows) {
      ws.addRow(row.map(numericOrText));
    }
  }
  return { xlsx: Buffer.from(await wb.xlsx.writeBuffer()), refused };
}

/**
 * Refuse a workbook whose sheets, measured from their cell records, are past
 * the cell budget together (./sheet-extent.ts). One sheet past it refuses
 * the file: anydoc reads a workbook whole.
 */
function assertWithinBudget(extents: readonly SheetExtent[]): void {
  let budget = MAX_LEGACY_CELLS;
  const over: RefusedSheet[] = [];
  for (const e of extents) {
    const cells = e.rows * e.cols;
    if (cells > budget) over.push(e);
    else budget -= cells;
  }
  if (over.length > 0) throw refusedError(over);
}

/** The anydoc half of the conversion, run in the parse worker: the sheets
 *  measured from their cell records and refused past the budget before
 *  anydoc is called, anydoc given the container rebuilt from what was
 *  measured, each laid-out sheet checked again before any row is copied,
 *  then rebuilt as `.xlsx`. `null` when the sheets cannot be measured or
 *  anydoc cannot read the file (an Excel 2007 beta `.xlsb`, a corrupt
 *  record, an encrypted workbook); a size limit throws. */
export async function legacySheetInProcess(bytes: Buffer): Promise<LegacyConversion | null> {
  const { measureLegacyWorkbook } = await import('./sheet-extent');
  const measured = await measureLegacyWorkbook(bytes);
  if (!measured) return null;
  assertWithinBudget(measured.extents);
  let read;
  try {
    const { anydocSheets } = await import('./anydoc');
    read = await anydocSheets(measured.bytes, 'xls', MAX_LEGACY_CELLS);
  } catch (err) {
    if (isDocumentLimitError(err)) throw err;
    return null;
  }
  const { kept, refused } = withinBudget(nonEmpty(read.sheets), read.refused);
  return rebuild(kept, refused);
}

/** The Tika half, run in the parse worker: Tika's XHTML rendering, under the
 *  same budget, rebuilt. */
export async function legacySheetFromXhtmlInProcess(
  xhtml: string,
): Promise<LegacyConversion | null> {
  const { kept, refused } = withinBudget(sheetsFromXhtml(xhtml));
  return rebuild(kept, refused);
}

/**
 * Convert legacy spreadsheet bytes to a real `.xlsx` buffer, with the sheets
 * refused for their size, or `null` when the file cannot be converted.
 *
 * An OOXML workbook under a legacy name comes back as it is (it already IS
 * an `.xlsx`). Otherwise anydoc reads the sheets in a worker first. Only a
 * file it cannot read goes to Tika's XHTML, and only on a box that runs the
 * Tika add-on. `mimeType` should be the legacy type for the extension (see
 * `mimeForExt`) so Tika does not have to guess.
 *
 * Throws a {@link DocumentLimitError} when the size limits stopped every
 * route (Tika, when on, is still asked first: it reads such a file in its
 * own heap).
 *
 * Cells are written as numbers where the rendered text is unambiguously
 * numeric and as strings otherwise — that keeps a numeric column numeric
 * through the round trip, which is the type that matters most downstream (it
 * drives both the grid's column type and Excel's own alignment/formatting).
 * anydoc renders a date as ISO text (`2017-03-09`), which sheet-to-grid
 * re-infers as a date; Tika gave display text (`3/9/17`).
 */
export function convertLegacySheetToXlsx(
  bytes: Buffer,
  mimeType: string,
): Promise<LegacyConversion | null> {
  if (isOoxmlWorkbook(bytes)) return Promise.resolve({ xlsx: bytes, refused: [] });
  const now = Date.now();
  const kept = conversions.get(bytes);
  if (kept && (kept.settledAt === null || kept.ok || now - kept.settledAt < FAILED_KEEP_MS)) {
    return kept.promise;
  }
  const entry: Conversion = { promise: convert(bytes, mimeType), settledAt: null, ok: false };
  conversions.set(bytes, entry);
  entry.promise.then(
    () => {
      entry.settledAt = Date.now();
      entry.ok = true;
    },
    (err: unknown) => {
      entry.settledAt = Date.now();
      // A retryable failure (busy, a first time-out) is not kept: the retry
      // must read again.
      if (isRetryableReadError(err)) conversions.delete(bytes);
    },
  );
  return entry.promise;
}

/**
 * One conversion per upload. The extractor hands every pass of one ingest
 * the same Buffer (its byte cache, server/api/src/agent/extract/
 * file-bytes.ts), so the auto-table pass and the text pass, which both
 * convert, share one anydoc read: keyed by the Buffer itself, gone with it.
 * A failure is kept a short while only, so the passes of one ingest share it
 * and a later retry reads again.
 */
type Conversion = {
  promise: Promise<LegacyConversion | null>;
  settledAt: number | null;
  ok: boolean;
};
const conversions = new WeakMap<Buffer, Conversion>();
const FAILED_KEEP_MS = 5 * 60_000;

async function convert(bytes: Buffer, mimeType: string): Promise<LegacyConversion | null> {
  const { runIsolated } = await import('./isolate');
  let limit: unknown = null;
  try {
    const converted = await runIsolated('legacySheet', [bytes]);
    if (converted) return converted;
  } catch (err) {
    if (!isDocumentLimitError(err)) throw err;
    limit = err;
  }
  if (tikaConfigured()) {
    const xhtml = await parseTikaBytes(bytes, { mimeType, accept: 'text/html' });
    if (xhtml) {
      const converted = await runIsolated('legacySheetFromXhtml', [xhtml]);
      if (converted) return converted;
    }
  }
  if (limit) throw limit;
  return null;
}

/** `"12.5"` → `12.5`; anything else stays the string (empty → null). */
function numericOrText(text: string): string | number | null {
  if (text === '') return null;
  // Deliberately strict: no thousands separators, no currency symbols. A
  // rendered "1,234" stays text here and is re-inferred downstream by
  // sheet-to-grid, which already knows how to strip separators.
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return text;
  const n = Number(text);
  return Number.isFinite(n) ? n : text;
}
