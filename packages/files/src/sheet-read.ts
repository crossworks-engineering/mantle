/**
 * Shared spreadsheet reading primitives, on top of `exceljs`.
 *
 * Both spreadsheet consumers sit on this: `./xlsx.ts` (flatten a workbook to
 * text for brain recall) and `./sheet-to-grid.ts` (preserve structure for the
 * Tables feature). Neither should know how a workbook is opened or how an
 * ExcelJS cell is coerced back to a plain JS value — that lives here, once.
 *
 * ## Why exceljs, and why the non-streaming reader
 *
 * SheetJS (`xlsx`) used to do this job. It left npm — the last registry
 * release is 0.18.5, which carries a prototype-pollution and a ReDoS advisory
 * that were both reachable here, because this package parses user-uploaded
 * bytes. exceljs is maintained, was already in the tree (server/web and
 * @mantle/content use it to WRITE .xlsx), and consolidating on it means one
 * spreadsheet engine for read and write instead of two.
 *
 * exceljs ships two readers. We deliberately use the **non-streaming**
 * `workbook.xlsx.load(buffer)`:
 *
 *   - `stream.xlsx.WorkbookReader` looks like the better tool (bounded rows,
 *     constant memory) but it is **zip-entry-order dependent**: it needs
 *     `xl/workbook.xml` to arrive before the worksheet entries, and throws
 *     `Cannot read properties of undefined (reading 'sheets')` when it does
 *     not. Plenty of real producers write `xl/workbook.xml` last — including
 *     SheetJS, and including exceljs's own `WorkbookWriter`. For arbitrary
 *     user uploads that is a coin flip, so it is not usable here.
 *   - `load()` reads the whole workbook. That costs memory (see the cap
 *     below) but it is order-independent and correct for every producer.
 *
 * ## The phantom-used-range hang is gone by construction
 *
 * The old SheetJS wrapper carried a `sheetRows` read cap and a column clamp
 * because `sheet_to_csv` walked the sheet's *declared* dimension. Spreadsheets
 * routinely declare a used range out to row 1,048,576 / column XFD when the
 * real data is a handful of cells, so an unbounded parse iterated millions of
 * phantom cells — minutes of synchronous, event-loop-blocking work. Two prod
 * uploads (720 KB and 591 KB) hung past the 10-minute trace watchdog that way.
 *
 * exceljs does not have that failure mode. It builds rows from the `<row>` and
 * `<c>` elements actually present in the sheet XML and ignores `<dimension>`
 * entirely. Measured: a workbook whose dimension claims `A1:XFD1048576` but
 * holds 4 real rows loads in 6 ms and reports `rowCount: 4`. The row/column
 * caps that survive downstream are therefore **output** caps (bounding what we
 * hand the embedder and the LLM), not hang guards.
 *
 * ## What replaces the read cap: an uncompressed-size pre-flight
 *
 * `load()` has no read-time bound, so a genuinely dense workbook is a memory
 * risk rather than a wall-clock one. Measured on this codebase: 100,000 rows x
 * 10 columns is 40.8 MB of uncompressed sheet XML (6.5 MB zipped) and peaks
 * around 1 GB RSS — roughly 25x the XML size. `MAX_UPLOAD_BYTES` is 64 MB, so
 * an unguarded `load()` could ask for tens of gigabytes.
 *
 * So we pre-flight: read the zip's central directory, sum the uncompressed
 * size of the worksheet parts, and refuse in-process parsing past a ceiling.
 * The caller decides what "refuse" means — `./xlsx.ts` falls through to Tika
 * (out-of-process, its own capped JVM heap), `./sheet-to-grid.ts` raises the
 * error to the user, because a partial grid import would be a lie.
 */

import ExcelJS from 'exceljs';
import JSZip from 'jszip';

/**
 * Ceiling on total uncompressed worksheet XML we will open in-process, in
 * bytes. 32 MB of sheet XML is ~80,000 rows x 10 columns and peaks near
 * 800 MB RSS at the ~25x blow-up measured above — already far past the
 * 5,000-row text cap and past anything a human reviews as a table. Above it,
 * the caller degrades rather than risking an extractor OOM.
 */
export const MAX_SHEET_XML_BYTES = 32 * 1024 * 1024;

/** Thrown by {@link loadWorkbook} when the pre-flight ceiling is exceeded. */
export class SpreadsheetTooLargeError extends Error {
  constructor(
    public readonly xmlBytes: number,
    public readonly limit: number,
  ) {
    super(
      `spreadsheet too large to parse in-process (${Math.round(xmlBytes / 1e6)} MB of sheet XML > ` +
        `${Math.round(limit / 1e6)} MB limit)`,
    );
    this.name = 'SpreadsheetTooLargeError';
  }
}

/**
 * Total uncompressed bytes of the `xl/worksheets/sheetN.xml` parts, read from
 * the zip directory without decompressing anything.
 *
 * Returns `null` when the size cannot be determined — not a valid zip (a
 * legacy .xls reaching here by mistake, or a corrupt upload), or a JSZip build
 * that no longer carries the field. `null` means "unknown", and the caller
 * treats unknown as allowed: refusing every workbook because we could not
 * measure one would be a worse failure than the one we are guarding against.
 */
export async function sheetXmlBytes(buf: Buffer): Promise<number | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    return null;
  }
  let total = 0;
  let measured = false;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) continue;
    // `_data.uncompressedSize` is JSZip-internal but has been stable across
    // the whole 3.x line, and it is the only way to get the inflated size
    // without inflating. Missing field → we simply cannot measure.
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    if (typeof size !== 'number' || !Number.isFinite(size)) continue;
    total += size;
    measured = true;
  }
  return measured ? total : null;
}

/**
 * Open an OOXML workbook (.xlsx / .xlsm) from bytes, after the size
 * pre-flight. Throws {@link SpreadsheetTooLargeError} when the workbook is
 * past {@link MAX_SHEET_XML_BYTES}, and whatever exceljs throws when the bytes
 * are not a readable workbook (encrypted, corrupt, or a legacy .xls that
 * should have gone through `./legacy-sheet.ts` first).
 */
export async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const bytes = await sheetXmlBytes(buf);
  if (bytes !== null && bytes > MAX_SHEET_XML_BYTES) {
    throw new SpreadsheetTooLargeError(bytes, MAX_SHEET_XML_BYTES);
  }
  const wb = new ExcelJS.Workbook();
  // exceljs's types want an ArrayBuffer-ish; a Node Buffer works at runtime.
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

/** A cell reduced to a plain JS value — what both consumers actually want. */
export type RawCell = string | number | boolean | Date | null;

/**
 * Coerce an ExcelJS cell value to a plain JS value.
 *
 * ExcelJS models a cell as a tagged object rather than a scalar: formulas
 * carry `{ formula, result }`, styled runs carry `{ richText: [...] }`, links
 * carry `{ text, hyperlink }`, and `#REF!`-style failures carry `{ error }`.
 * Every consumer here wants the VALUE, never the formula text — the same
 * choice the SheetJS wrapper made by reading each cell's cached computed
 * value. So formulas resolve to their last-computed result, rich text
 * flattens to its concatenated runs, and hyperlinks keep their display text
 * (the URL is noise in both a recall index and a typed grid column).
 */
export function rawCellValue(value: ExcelJS.CellValue): RawCell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') return value as RawCell;
  if (t !== 'object') return String(value);

  const obj = value as unknown as Record<string, unknown>;
  if (Array.isArray(obj.richText)) {
    return (obj.richText as Array<{ text?: unknown }>).map((r) => String(r?.text ?? '')).join('');
  }
  // Formula cells: `result` is the cached value Excel last computed. It can
  // itself be an error object, so recurse rather than stringifying blindly.
  if ('formula' in obj || 'sharedFormula' in obj) {
    return 'result' in obj ? rawCellValue(obj.result as ExcelJS.CellValue) : null;
  }
  if ('error' in obj) return String(obj.error);
  if ('text' in obj) return rawCellValue(obj.text as ExcelJS.CellValue);
  // A merge-continuation cell points at its master; the master already
  // supplied the value, so the continuation contributes nothing.
  if ('sharedString' in obj) return String(obj.sharedString);
  return null;
}

/**
 * Read a worksheet as an array of rows, each row an array of {@link RawCell}
 * aligned to column 1..width. Trailing empty rows and columns are not emitted;
 * interior blanks become `null` so column alignment is preserved.
 *
 * `maxRows` / `maxCols` bound the OUTPUT (see the module note — they are not
 * hang guards any more). `truncated` reports whether either bit.
 */
export function worksheetToRows(
  ws: ExcelJS.Worksheet,
  opts: { maxRows: number; maxCols: number },
): { rows: RawCell[][]; truncated: boolean } {
  const width = Math.min(Math.max(ws.columnCount, 0), opts.maxCols);
  const truncatedCols = ws.columnCount > opts.maxCols;
  const rows: RawCell[][] = [];
  let truncatedRows = false;

  // `eachRow` visits only rows that exist, in order, so a sparse sheet costs
  // nothing for its gaps. `includeEmpty: false` skips wholly-blank rows, which
  // is what both consumers want — but it also means row numbers are not
  // contiguous, and neither consumer depends on the original row index.
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length >= opts.maxRows) {
      truncatedRows = true;
      return;
    }
    const out: RawCell[] = new Array(width).fill(null);
    for (let c = 1; c <= width; c++) {
      out[c - 1] = rawCellValue(row.getCell(c).value);
    }
    rows.push(out);
  });

  return { rows, truncated: truncatedRows || truncatedCols };
}
