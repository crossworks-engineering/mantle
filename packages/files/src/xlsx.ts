/**
 * Spreadsheet text extraction, on `exceljs` (see ./sheet-read.ts for why that
 * engine and that reader).
 *
 * Handles the OOXML formats exceljs reads natively — `.xlsx` and `.xlsm`. The
 * legacy binaries (`.xls`, `.xlsb`) are converted to `.xlsx` upstream in
 * `./read-document.ts` and arrive here as ordinary modern bytes, so this
 * module has one code path for every spreadsheet in the system. Runs in the
 * parser service (server/parser) only.
 *
 * Each sheet is rendered as CSV under a `# Sheet: <name>` header so the LLM
 * can tell tabs apart; blank rows are dropped. Formulas resolve to their
 * last-computed value, not the formula text.
 *
 * This flattens the workbook to text — fine for "what's in this spreadsheet"
 * recall, not for preserving structure. `./sheet-to-grid.ts` is the structured
 * twin.
 *
 * **Bounded on purpose, but for a different reason than before.** Under
 * SheetJS the caps here were hang guards: `sheet_to_csv` walked the sheet's
 * declared dimension, so an inflated used-range meant iterating millions of
 * phantom cells, and two prod uploads hung ingest past the 10-minute watchdog
 * that way. exceljs reads only the rows and cells that exist, so that hazard
 * is gone by construction. The row/column/character caps below survive as
 * OUTPUT bounds — they cap what we hand the chunker and the embedder. Past
 * the pre-flight in ./sheet-read.ts the workbook is read as a stream, so
 * memory holds the kept rows, not the sheet.
 *
 * Separate entry point (`@mantle/files/xlsx`) so the spreadsheet engine is
 * only loaded when a spreadsheet actually shows up.
 */

import { noteReadCut } from './read-cut-sink';
import {
  loadWorkbook,
  SpreadsheetTooLargeError,
  streamWorkbookRows,
  worksheetToRows,
  type RawCell,
} from './sheet-read';

/** Rows rendered per sheet. Generous for recall + summary. */
const MAX_ROWS_PER_SHEET = 5_000;
/** Columns rendered per sheet. */
const MAX_COLS_PER_SHEET = 256;
/** Total CSV chars across all sheets — the backstop against a legitimately
 *  dense workbook (many sheets, each near the row/col caps) emitting an
 *  unbounded body. Aligned with the extractor's `TEXT_STORE_MAX_CHARS` (the
 *  per-node retrievable-text ceiling): the extractor chunks+stores up to that
 *  much for EVERY format, so a spreadsheet shouldn't be a tighter special case
 *  — its rows become individually-embedded `search_chunks` passages like any
 *  other document. Note the LLM bill is bounded SEPARATELY and independently
 *  (the summary prompt is truncated to ~24K chars upstream), so a larger body
 *  here only widens chunk/retrieval coverage, it doesn't grow token cost. */
const MAX_TEXT_CHARS = 1_000_000;
const TRUNCATION_NOTE = '[spreadsheet truncated for indexing — large or sparse workbook]';

/** Render one cell for CSV. Dates become ISO — under SheetJS they came out as
 *  whatever Excel's display format happened to be ("1/15/26"), which is both
 *  ambiguous and locale-dependent; ISO sorts, parses, and matches a query
 *  containing a real date. A pure date (midnight UTC) drops its time half. */
function cellText(v: RawCell): string {
  if (v === null) return '';
  if (v instanceof Date) {
    const iso = v.toISOString();
    return v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0
      ? iso.slice(0, 10)
      : iso;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** RFC 4180 quoting: quote when the value carries a comma, quote or newline. */
function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows: RawCell[][]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const cells = row.map((c) => csvField(cellText(c)));
    // Trailing empties carry no information in CSV; drop them so a sheet whose
    // used range is wider than its data doesn't emit ranks of bare commas.
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length === 0) continue; // wholly blank row
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

/** One sheet's rows for the text: the first MAX_ROWS_PER_SHEET rows of at
 *  most MAX_COLS_PER_SHEET columns, and the sheet's row and column counts
 *  (`atLeast`: the read stopped in this sheet, it has at least that many). */
type SheetRows = {
  name: string;
  rows: RawCell[][];
  rowsTotal: number;
  colsTotal: number;
  atLeast?: true;
};

/** The sheets of a workbook for its text, and how many sheets it has. One
 *  past the size check of ./sheet-read.ts is read as a stream: its first
 *  rows are kept, and the read stops at the first sheet past the row cap
 *  (reading on through millions of rows would pass the job's time limit).
 *  The cut says so; nothing is refused whole. */
async function sheetsOf(buf: Buffer): Promise<{ sheets: SheetRows[]; total: number }> {
  try {
    const wb = await loadWorkbook(buf);
    const sheets = wb.worksheets.map((ws) => {
      const s = worksheetToRows(ws, { maxRows: MAX_ROWS_PER_SHEET, maxCols: MAX_COLS_PER_SHEET });
      return { name: ws.name, rows: s.rows, rowsTotal: s.rowsTotal, colsTotal: s.colsTotal };
    });
    return { sheets, total: sheets.length };
  } catch (err) {
    if (!(err instanceof SpreadsheetTooLargeError)) throw err;
  }
  const sheets: SheetRows[] = [];
  const bySheet = new Map<number, SheetRows>();
  const { sheets: total } = await streamWorkbookRows(buf, (name, cells, sheetNo) => {
    let cur = bySheet.get(sheetNo);
    if (!cur) {
      cur = { name, rows: [], rowsTotal: 0, colsTotal: 0 };
      bySheet.set(sheetNo, cur);
      sheets.push(cur);
    }
    cur.rowsTotal += 1;
    cur.colsTotal = Math.max(cur.colsTotal, cells.length);
    if (cur.rows.length < MAX_ROWS_PER_SHEET) {
      cur.rows.push(cells.slice(0, MAX_COLS_PER_SHEET));
      return true;
    }
    cur.atLeast = true;
    return false;
  });
  return { sheets, total };
}

/**
 * Flatten a workbook to `# Sheet: <name>` + CSV blocks.
 *
 * Returns `''` when there is nothing tabular to index. A workbook past the
 * size ceiling of ./sheet-read.ts is read as a stream (sheetsOf), with the
 * same caps and the same cuts said, never refused whole.
 */
export async function parseXlsx(buf: Buffer): Promise<string> {
  const { sheets, total: sheetsTotal } = await sheetsOf(buf);

  const parts: string[] = [];
  let total = 0;
  let truncated = false;
  const rows = { read: 0, total: 0 };
  const cols = { read: 0, total: 0 };
  let sheetsRead = -1;

  for (const [i, sheet] of sheets.entries()) {
    if (sheet.rowsTotal > sheet.rows.length || sheet.colsTotal > MAX_COLS_PER_SHEET) {
      truncated = true;
    }
    if (sheet.rowsTotal > sheet.rows.length) {
      rows.read += sheet.rows.length;
      rows.total += sheet.rowsTotal;
    }
    if (sheet.colsTotal > MAX_COLS_PER_SHEET) {
      cols.read += MAX_COLS_PER_SHEET;
      cols.total += sheet.colsTotal;
    }
    const csv = rowsToCsv(sheet.rows).trim();
    if (csv.length === 0) continue;

    if (total + csv.length > MAX_TEXT_CHARS) {
      const room = MAX_TEXT_CHARS - total;
      if (room > 0) parts.push(`# Sheet: ${sheet.name}\n${csv.slice(0, room)}`);
      truncated = true;
      // This sheet in part, and every sheet after it not read at all.
      sheetsRead = i;
      break; // stop before rendering any further sheets
    }
    parts.push(`# Sheet: ${sheet.name}\n${csv}`);
    total += csv.length;
  }
  const atLeast = sheets.some((s) => s.atLeast);
  if (rows.total > 0) {
    noteReadCut('sheet_rows', {
      what: 'rows',
      ...rows,
      ...(atLeast ? { atLeast: true as const } : {}),
      limit: MAX_ROWS_PER_SHEET,
    });
  }
  if (cols.total > 0) {
    noteReadCut('sheet_columns', { what: 'columns', ...cols, limit: MAX_COLS_PER_SHEET });
  }
  if (sheetsRead >= 0) {
    noteReadCut('sheet_text', {
      what: 'sheets',
      read: sheetsRead,
      total: sheetsTotal,
      limit: MAX_TEXT_CHARS,
    });
  } else if (sheets.length < sheetsTotal) {
    // A stream read that stopped in a long sheet: the sheets after it are
    // not read (no limit: the sentence says why).
    noteReadCut('sheet_text', { what: 'sheets', read: sheets.length, total: sheetsTotal });
  }

  let out = parts.join('\n\n').trim();
  if (truncated && out.length > 0) out += `\n\n${TRUNCATION_NOTE}`;
  return out;
}
