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
import { envNum } from '@mantle/config';
import { LEGACY_SHEET_EXTS } from './slug';
import type { RowsSpill, SpilledTab } from './sheet-spill';
import {
  GridFold,
  eachDelimitedRow,
  looksLikeWorkbook,
  parseDelimited,
  parseSheet,
  readsAsDelimited,
  type ParsedSheet,
  type RowKeeper,
} from './sheet-to-grid';

/**
 * A file database read that may write its rows to a file (./sheet-spill.ts;
 * the package `sheet` with `request.spill`). A read past what memory takes
 * (a CSV past MANTLE_FILE_DB_CSV_MAX_MB, a workbook past the size check of
 * ./sheet-read.ts, which is read as a stream) opens the rows file with
 * `open`, writes each kept body row to it, and names its tabs in `spilled`:
 * those tabs come back with no rows. Any other read is in memory, as
 * before, and `spill` stays unset.
 */
export type SpillTo = { open: () => RowsSpill; spill?: RowsSpill; spilled: SpilledTab[] };

/** Fold one raw row of a sheet whose rows go to the rows file: the header
 *  starts the sheet's tab in the file (so a sheet with no row that is not
 *  blank has none), a body row is written while the spill keeps rows, and
 *  only a kept row is folded into the types. False: the cut is reached. */
function spillRow(
  sheet: { fold: GridFold; tab: number | null },
  cells: readonly unknown[],
  to: SpillTo & { spill: RowsSpill },
): boolean {
  const kind = sheet.fold.kindOf(cells);
  if (kind === 'blank') return true;
  if (kind === 'header') {
    sheet.tab = to.spilled.length;
    to.spilled.push({ tab: sheet.tab, rows: 0, keep: [] });
    to.spill.startTab(sheet.tab);
    sheet.fold.add(cells);
    return true;
  }
  if (!to.spill.take(cells)) return false;
  sheet.fold.add(cells);
  to.spilled[sheet.tab!]!.rows += 1;
  return true;
}

/** The tabs of the sheets whose rows went to the rows file: each with its
 *  columns and no rows, in the order of `to.spilled`, whose `keep` is set. */
function spilledTabs(
  sheets: readonly { name: string; fold: GridFold; tab: number | null }[],
  to: SpillTo,
): ParsedSheet[] {
  const out: ParsedSheet[] = [];
  for (const s of sheets) {
    if (s.tab === null) continue;
    // A sheet with a header always has a shape: the header has a cell.
    const shape = s.fold.shape()!;
    to.spilled[s.tab]!.keep = shape.keep;
    out.push({ name: s.name, columns: shape.columns, rows: [] });
  }
  return out;
}

/** Delimited text to grids: in memory, as before, but for a read that may
 *  write its rows to a file (`to`), which is never cut for memory: a CSV
 *  past the budget, or one whose cells pass it in memory, is read with its
 *  rows to the file. */
async function readDelimitedGrid(
  buf: Buffer,
  keep: RowKeeper | undefined,
  to: SpillTo | undefined,
): Promise<ParsedSheet[]> {
  if (to && buf.length > envNum('MANTLE_FILE_DB_CSV_MAX_MB') * 1024 * 1024) {
    return spillDelimited(buf, to);
  }
  const tabs = await parseDelimited(buf, keep);
  return to && keep?.cut()?.database_size ? spillDelimited(buf, to) : tabs;
}

/** A long CSV, its rows to the rows file. The reader counts every row past
 *  the cut, but stops at the step's deadline ("at least"), so the count
 *  never costs the job. */
async function spillDelimited(buf: Buffer, to: SpillTo): Promise<ParsedSheet[]> {
  const spill = (to.spill = to.open());
  const sheet = { name: 'Sheet1', fold: new GridFold(), tab: null as number | null };
  try {
    await eachDelimitedRow(buf, (row) => {
      if (spill.full) {
        if (Date.now() > spill.until) {
          spill.atLeast = true;
          return false;
        }
        // Past the cut, a body row is counted only.
        if (sheet.fold.kindOf(row) === 'body') spill.take(row);
        return true;
      }
      spillRow(sheet, row, to as SpillTo & { spill: RowsSpill });
      return true;
    });
  } finally {
    spill.close();
  }
  return spilledTabs([sheet], to);
}

/** A workbook past the size check, read as a stream, its rows to the rows
 *  file. The stream stops at the cut: the rows past it are "at least". */
export async function spillWorkbook(buf: Buffer, to: SpillTo): Promise<ParsedSheet[]> {
  const { streamWorkbookRows } = await import('./sheet-read');
  const spill = (to.spill = to.open());
  // By sheet number: two sheets can share a name the reader gives.
  const sheets = new Map<number, { name: string; fold: GridFold; tab: number | null }>();
  try {
    await streamWorkbookRows(buf, (name, cells, sheetNo) => {
      let sheet = sheets.get(sheetNo);
      if (!sheet) sheets.set(sheetNo, (sheet = { name, fold: new GridFold(), tab: null }));
      if (
        spillRow(
          sheet,
          cells.slice(0, GRID_MAX_COLS_PER_SHEET),
          to as SpillTo & { spill: RowsSpill },
        )
      ) {
        return true;
      }
      spill.atLeast = true;
      return false;
    });
  } finally {
    spill.close();
  }
  return spilledTabs([...sheets.values()], to);
}

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
  to?: SpillTo,
): Promise<ParsedSheet[]> {
  // Bytes that are no workbook are delimited text, under any name but a
  // legacy one (readsAsDelimited), read as a stream. Past what memory takes,
  // a read that may (`to`) writes its rows to a file.
  if (readsAsDelimited(buf, ext)) return readDelimitedGrid(buf, keep, to);
  if (!LEGACY_SHEET_EXTS.has(ext.toLowerCase())) return parseSheetToGrid(buf, keep, to);
  // Loaded here, not at the top: delimited text (a CSV job) never needs
  // exceljs, which both of these files load.
  const { convertLegacySheetToXlsx } = await import('./legacy-sheet');
  const converted = await convertLegacySheetToXlsx(buf);
  if (!converted) {
    throw new Error(
      `could not convert legacy .${ext} workbook: the file is not a readable spreadsheet`,
    );
  }
  return parseSheetToGrid(converted.xlsx, keep, to);
}

/**
 * Rows read per sheet for a grid import: Excel's own row limit, so it never
 * cuts (a sheet of 1,048,576 tiny rows fits under the size check). The real
 * ceilings are the pre-flight in ./sheet-read.ts, which fails LOUDLY for an
 * import, the row keeper of a file database read, and the import layer's own
 * TABLE_IMPORT_MAX_ROWS.
 */
const GRID_MAX_ROWS_PER_SHEET = 1_048_576;
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
export async function parseSheetToGrid(
  buf: Buffer,
  keep?: RowKeeper,
  to?: SpillTo,
): Promise<ParsedSheet[]> {
  if (bytesLookLikeLegacyBiff(buf)) {
    throw new Error(
      'legacy .xls/.xlsb workbook: convert it with convertLegacySheetToXlsx before importing',
    );
  }
  if (!looksLikeWorkbook(buf)) return readDelimitedGrid(buf, keep, to);
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
    // A read that may write its rows to a file does, and keeps them all.
    if (to) return spillWorkbook(buf, to);
    // By sheet number: two sheets can share a name the reader gives.
    const sheets = new Map<number, { name: string; rows: unknown[][] }>();
    await streamWorkbookRows(buf, (name, cells, sheetNo) => {
      let sheet = sheets.get(sheetNo);
      if (!sheet) sheets.set(sheetNo, (sheet = { name, rows: [] }));
      if (!keep.take(cells, sheetNo)) {
        // The stream stops at the cut: the rows past it are not counted.
        keep.atLeast = true;
        return false;
      }
      sheet.rows.push(cells.slice(0, GRID_MAX_COLS_PER_SHEET));
      return true;
    });
    return [...sheets.values()].flatMap((s) => parseSheet(s.name, s.rows));
  }
  const out: ParsedSheet[] = [];
  for (const ws of wb.worksheets) {
    const { rows } = worksheetToRows(ws, {
      maxRows: GRID_MAX_ROWS_PER_SHEET,
      maxCols: GRID_MAX_COLS_PER_SHEET,
    });
    out.push(
      ...parseSheet(ws.name, keep ? rows.filter((r) => keep.take(r, ws)) : (rows as unknown[][])),
    );
  }
  // A read that may write its rows to a file is never cut for memory: a
  // workbook under the size check whose cells pass the budget (its shared
  // strings) is read again as a stream, its rows to the file.
  if (to && keep?.cut()?.database_size) return spillWorkbook(buf, to);
  return out;
}

function bytesLookLikeLegacyBiff(buf: Buffer): boolean {
  return (
    buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1
  );
}
