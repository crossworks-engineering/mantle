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
 * size of the worksheet parts, and refuse in-process parsing past a ceiling
 * ({@link SpreadsheetTooLargeError}). Past it, the text read (./xlsx.ts) and
 * a file database read (./sheet-grid.ts with a row keeper) read the
 * workbook as a stream instead ({@link streamWorkbookRows}, the ingest
 * program): in part where their caps stop, never refused whole. A by-hand import
 * still refuses it (`too_large`): a partial import would be a lie. The
 * whole-workbook reader stays under the ceiling, as it fills merged cells
 * and the stream does not (sheet-read-stream.test.ts).
 */

import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { DocumentTooLargeError } from './read-limit';

/**
 * Ceiling on total uncompressed worksheet XML we will open in-process, in
 * bytes. 32 MB of sheet XML is ~80,000 rows x 10 columns and peaks near
 * 800 MB RSS at the ~25x blow-up measured above — already far past the
 * 5,000-row text cap and past anything a human reviews as a table. Above it,
 * the caller degrades rather than risking an extractor OOM.
 */
export const MAX_SHEET_XML_BYTES = 32 * 1024 * 1024;

/** Thrown by {@link loadWorkbook} when the pre-flight ceiling is exceeded. */
export class SpreadsheetTooLargeError extends DocumentTooLargeError {
  constructor(
    public readonly xmlBytes: number,
    public readonly limit: number,
  ) {
    super(
      `spreadsheet too large to read (${Math.round(xmlBytes / 1e6)} MB of sheet XML > ` +
        `${Math.round(limit / 1e6)} MB limit)`,
    );
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

/**
 * The rows of every sheet of an OOXML workbook, read as a stream (exceljs's
 * `stream.xlsx.WorkbookReader`), one row at a time: a workbook past
 * {@link MAX_SHEET_XML_BYTES} is read this way, in part where its reader
 * stops (the ingest program), never refused whole. Memory holds the shared
 * strings and the row in hand, not the sheet.
 *
 * The stream reader needs `xl/workbook.xml` before the sheets (see the
 * module note), and many producers write it last. So the zip is given to it
 * in a fixed order: the workbook, its rels, the shared strings and the
 * styles first, then the rest. JSZip writes the entries in the order of its
 * `files`, and a DEFLATE entry keeps its compressed bytes (no inflate). The
 * styles are read, so a date cell is a Date, as `load()` gives it.
 *
 * `visit` takes each row's cells (column 1 first, trailing blanks dropped),
 * its sheet's name and its sheet's number (1 first, in the zip's order);
 * it returns `false` to stop the read (the rest of the file is not
 * inflated). The answer is the workbook's sheet count. A reader stops at its
 * cut: reading on only to count the rest of a sheet of millions of rows
 * would pass the step's time limit.
 *
 * What the stream gives that the whole reader does not (the golden files,
 * sheet-read-stream.test.ts): a merged cell's value in its first cell only,
 * and no value for a formula whose cached result is an error (#DIV/0!) or
 * an empty text. So the whole reader stays under the size check.
 */
export async function streamWorkbookRows(
  buf: Buffer,
  visit: (sheet: string, cells: RawCell[], sheetNo: number) => boolean,
): Promise<{ sheets: number }> {
  const zip = await JSZip.loadAsync(buf);
  const ordered = new JSZip();
  const files = ordered.files as Record<string, JSZip.JSZipObject>;
  for (const name of [
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/sharedStrings.xml',
    'xl/styles.xml',
  ]) {
    if (zip.files[name]) files[name] = zip.files[name]!;
    // With no shared strings the reader keeps every sheet in a temp file
    // until the end (the parser's /tmp is memory): an empty table instead.
    else if (name === 'xl/sharedStrings.xml') ordered.file(name, EMPTY_SHARED_STRINGS);
  }
  for (const [name, entry] of Object.entries(zip.files)) if (!(name in files)) files[name] = entry;
  // The sizes go in each local header (streamFiles off): the reader then
  // never looks for an entry's end in its compressed bytes. JSZip's stream
  // is not a node stream.Readable (the reader's test of its input), so it
  // goes through a PassThrough.
  const input = ordered
    .generateNodeStream({ type: 'nodebuffer', streamFiles: false, compression: 'DEFLATE' })
    .pipe(new PassThrough());
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, {
    sharedStrings: 'cache',
    styles: 'cache',
    hyperlinks: 'ignore',
    worksheets: 'emit',
    entries: 'ignore',
  });
  const sheetsOf = () =>
    (reader as unknown as { model?: { sheets?: unknown[] } }).model?.sheets?.length ?? 0;
  let sheetNo = 0;
  for await (const ws of reader) {
    sheetNo += 1;
    const name = (ws as unknown as { name?: string }).name ?? `Sheet${sheetNo}`;
    for await (const row of ws as unknown as AsyncIterable<ExcelJS.Row>) {
      const values = row.values as ExcelJS.CellValue[];
      const cells: RawCell[] = [];
      for (let c = 1; c < values.length; c++) {
        const v = rawCellValue(values[c] ?? null);
        // The stream reader reads a formula's cached error (#DIV/0!) as a
        // number, NaN: no value, as a blank.
        cells.push(typeof v === 'number' && Number.isNaN(v) ? null : v);
      }
      while (cells.length > 0 && cells[cells.length - 1] === null) cells.pop();
      if (cells.length === 0) continue;
      if (!visit(name, cells, sheetNo)) {
        input.destroy();
        return { sheets: Math.max(sheetsOf(), sheetNo) };
      }
    }
  }
  return { sheets: Math.max(sheetsOf(), sheetNo) };
}

/** A shared strings part with no strings. */
const EMPTY_SHARED_STRINGS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>';

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
): {
  rows: RawCell[][];
  truncated: boolean;
  /** Rows with a value in the sheet, the ones past `maxRows` too. */
  rowsTotal: number;
  /** Columns of the sheet (its column count), the ones past `maxCols` too. */
  colsTotal: number;
} {
  const width = Math.min(Math.max(ws.columnCount, 0), opts.maxCols);
  const truncatedCols = ws.columnCount > opts.maxCols;
  const rows: RawCell[][] = [];
  let truncatedRows = false;
  let rowsTotal = 0;

  // `eachRow` visits only rows that exist, in order, so a sparse sheet costs
  // nothing for its gaps. `includeEmpty: false` skips wholly-blank rows, which
  // is what both consumers want — but it also means row numbers are not
  // contiguous, and neither consumer depends on the original row index.
  ws.eachRow({ includeEmpty: false }, (row) => {
    rowsTotal += 1;
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

  return {
    rows,
    truncated: truncatedRows || truncatedCols,
    rowsTotal,
    colsTotal: Math.max(ws.columnCount, 0),
  };
}
