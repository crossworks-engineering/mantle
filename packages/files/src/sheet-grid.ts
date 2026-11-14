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
export async function readSpreadsheetGrid(buf: Buffer, ext: string): Promise<ParsedSheet[]> {
  // The test the core's early cap uses too (readsAsDelimited), so a cap on
  // delimited text holds for every name this reads as text.
  if (readsAsDelimited(buf, ext)) return parseDelimited(buf.toString('utf-8'));
  if (!LEGACY_SHEET_EXTS.has(ext.toLowerCase())) return parseSheetToGrid(buf);
  // Loaded here, not at the top: delimited text (a CSV job) never needs
  // exceljs, which both of these files load.
  const { convertLegacySheetToXlsx } = await import('./legacy-sheet');
  const converted = await convertLegacySheetToXlsx(buf);
  if (!converted) {
    throw new Error(
      `could not convert legacy .${ext} workbook: the file is not a readable spreadsheet`,
    );
  }
  return parseSheetToGrid(converted.xlsx);
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
 * corrupt) or one past the in-process size ceiling raises, because a partial
 * or empty grid import would silently look like a successful one. Both call
 * sites already surface the message to the user.
 */
export async function parseSheetToGrid(buf: Buffer): Promise<ParsedSheet[]> {
  if (bytesLookLikeLegacyBiff(buf)) {
    throw new Error(
      'legacy .xls/.xlsb workbook: convert it with convertLegacySheetToXlsx before importing',
    );
  }
  // No workbook by its bytes (a zip or an OLE2 file, `looksLikeWorkbook`):
  // delimited text. An OLE2 file was refused above, so what is left is a zip.
  if (!looksLikeWorkbook(buf)) return parseDelimited(buf.toString('utf-8'));
  const { loadWorkbook, worksheetToRows } = await import('./sheet-read');
  const wb = await loadWorkbook(buf);
  const out: ParsedSheet[] = [];
  for (const ws of wb.worksheets) {
    const { rows } = worksheetToRows(ws, {
      maxRows: GRID_MAX_ROWS_PER_SHEET,
      maxCols: GRID_MAX_COLS_PER_SHEET,
    });
    out.push(...parseSheet(ws.name, rows as unknown[][]));
  }
  return out;
}

/** OLE2 compound-file magic (`D0 CF 11 E0 A1 B1 1A E1`): a legacy `.xls` or
 *  `.xlsb`. Detected explicitly so such bytes raise a message that names the
 *  fix, instead of being read as UTF-8 and yielding a grid of mojibake. */
function bytesLookLikeLegacyBiff(buf: Buffer): boolean {
  return (
    buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1
  );
}
