/**
 * Workbook → grids: the reader half of ./sheet-to-grid.ts. Runs in the parser
 * service (server/parser) only; the brain asks for it through the parser
 * client (`parseSpreadsheetToGrid` in ./sheet-to-grid.ts).
 *
 * Workbooks are read with `exceljs` via ./sheet-read.ts (that module carries
 * the reasoning: why exceljs replaced SheetJS, why the non-streaming reader,
 * and why an uncompressed-size pre-flight replaced the old read cap). Legacy
 * binaries (.xls / .xlsb) are converted to .xlsx first (./legacy-sheet.ts,
 * anydoc), so there is one reader for every spreadsheet.
 */
import { LEGACY_SHEET_EXTS } from './slug';
import {
  looksLikeWorkbook,
  parseDelimited,
  parseSheet,
  readsAsDelimited,
  type ParsedSheet,
  type RowKeeper,
} from './sheet-to-grid';

/**
 * The parser's grid read: bytes plus their extension → grids, converting a
 * legacy binary first when there is one.
 *
 * `parseSheetToGrid` below reads OOXML or delimited text; this wrapper adds
 * the legacy conversion.
 *
 * Throws when a legacy file cannot be converted, so the caller reports a real
 * reason rather than "no tabular data found".
 */
export async function readSpreadsheetGrid(
  buf: Buffer,
  ext: string,
  keep?: RowKeeper,
): Promise<ParsedSheet[]> {
  // Bytes that are no workbook are delimited text, under any name but a
  // legacy one (readsAsDelimited), read as a stream.
  if (readsAsDelimited(buf, ext)) return parseDelimited(buf, keep);
  if (!LEGACY_SHEET_EXTS.has(ext.toLowerCase())) return parseSheetToGrid(buf, keep);
  // Loaded here, not at the top: delimited text (a CSV job) never needs
  // exceljs, which both of these files load.
  const { convertLegacySheetToXlsx } = await import('./legacy-sheet');
  const converted = await convertLegacySheetToXlsx(buf);
  if (!converted) {
    throw new Error(
      `could not convert legacy .${ext} workbook: the file is not a readable spreadsheet`,
    );
  }
  return parseSheetToGrid(converted.xlsx, keep);
}

/**
 * Rows read per sheet for a grid import. Deliberately far above anything a
 * person reviews as a table: the real ceiling for this path is the
 * uncompressed-XML pre-flight in ./sheet-read.ts (~80k rows at the current
 * limit), which fails LOUDLY, and above that the import layer's own
 * TABLE_IMPORT_MAX_ROWS. This cap only exists so `worksheetToRows` has a
 * number; it should never be the thing that bites.
 */
const GRID_MAX_ROWS_PER_SHEET = 1_000_000;
/** Columns read per sheet. Excel's own hard ceiling is 16,384 (XFD). */
const GRID_MAX_COLS_PER_SHEET = 16_384;

/**
 * Parse a spreadsheet into one ParsedSheet per non-empty sheet.
 *
 * Accepts modern workbooks (.xlsx / .xlsm) and delimited text (.csv / .tsv),
 * which yields a single sheet named "Sheet1". Legacy binaries must be
 * converted first (`convertLegacySheetToXlsx`): `looksLikeWorkbook` tells
 * them apart. Returns an empty array if nothing tabular is found.
 *
 * **Throws** rather than degrading: an unreadable workbook (encrypted,
 * corrupt) or, for an import, one past the in-process size ceiling raises,
 * because a partial or empty grid import would silently look like a
 * successful one. A file database read gives a `keep` (RowKeeper): it reads
 * such a workbook as a stream and keeps its head, and the keeper says the
 * cut (the ingest program).
 */
export async function parseSheetToGrid(buf: Buffer, keep?: RowKeeper): Promise<ParsedSheet[]> {
  if (bytesLookLikeLegacyBiff(buf)) {
    throw new Error(
      'legacy .xls/.xlsb workbook: convert it with convertLegacySheetToXlsx before importing',
    );
  }
  if (!looksLikeWorkbook(buf)) return parseDelimited(buf, keep);
  const { loadWorkbook, worksheetToRows, streamWorkbookRows, SpreadsheetTooLargeError } =
    await import('./sheet-read');
  let wb;
  try {
    wb = await loadWorkbook(buf);
  } catch (err) {
    // A file database read (`keep`) reads a workbook past the size check as
    // a stream and keeps its head (the ingest program). An import (no
    // `keep`) still refuses it whole: a partial import would be a lie.
    if (!keep || !(err instanceof SpreadsheetTooLargeError)) throw err;
    const sheets = new Map<string, unknown[][]>();
    await streamWorkbookRows(buf, (name, cells) => {
      let rows = sheets.get(name);
      if (!rows) sheets.set(name, (rows = []));
      if (keep.take(cells)) rows.push(cells.slice(0, GRID_MAX_COLS_PER_SHEET));
      return true; // read on: the rows past the cut are counted
    });
    return [...sheets].flatMap(([name, rows]) => parseSheet(name, rows));
  }
  const out: ParsedSheet[] = [];
  for (const ws of wb.worksheets) {
    const { rows } = worksheetToRows(ws, {
      maxRows: GRID_MAX_ROWS_PER_SHEET,
      maxCols: GRID_MAX_COLS_PER_SHEET,
    });
    out.push(
      ...parseSheet(ws.name, keep ? rows.filter((r) => keep.take(r)) : (rows as unknown[][])),
    );
  }
  return out;
}

function bytesLookLikeLegacyBiff(buf: Buffer): boolean {
  return (
    buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1
  );
}
