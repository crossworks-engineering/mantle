/**
 * Spreadsheet text extraction, on `exceljs` (see ./sheet-read.ts for why that
 * engine and that reader).
 *
 * Handles the OOXML formats exceljs reads natively — `.xlsx` and `.xlsm`. The
 * legacy binaries (`.xls`, `.xlsb`) are converted to `.xlsx` upstream in
 * `./parse.ts` and arrive here as ordinary modern bytes, so this module has
 * one code path for every spreadsheet in the system.
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
 * OUTPUT bounds — they cap what we hand the chunker and the embedder. The
 * memory bound that replaced `sheetRows` is the pre-flight in ./sheet-read.ts.
 *
 * Separate entry point (`@mantle/files/xlsx`) so the spreadsheet engine is
 * only loaded when a spreadsheet actually shows up.
 */

import {
  SpreadsheetTooLargeError,
  loadWorkbook,
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

/**
 * Flatten a workbook to `# Sheet: <name>` + CSV blocks.
 *
 * Returns `''` when there is nothing tabular to index. A workbook past the
 * in-process size ceiling falls through to Tika, which streams the parse in
 * its own heap-capped container rather than in the extractor's process — a
 * lower-fidelity rendering of a workbook nobody was going to read as a table
 * anyway, and far better than an OOM.
 */
export async function parseXlsx(buf: Buffer): Promise<string> {
  let wb;
  try {
    wb = await loadWorkbook(buf);
  } catch (err) {
    if (err instanceof SpreadsheetTooLargeError) {
      const { parseTikaBytes } = await import('./tika');
      const { mimeForExt } = await import('./slug');
      return parseTikaBytes(buf, { mimeType: mimeForExt('xlsx') });
    }
    throw err;
  }

  const parts: string[] = [];
  let total = 0;
  let truncated = false;

  for (const ws of wb.worksheets) {
    // Hidden sheets are usually lookup tables and scratch space the author
    // chose not to show; index them anyway — recall wants the content, and a
    // hidden sheet is not a private one.
    const { rows, truncated: sheetTruncated } = worksheetToRows(ws, {
      maxRows: MAX_ROWS_PER_SHEET,
      maxCols: MAX_COLS_PER_SHEET,
    });
    if (sheetTruncated) truncated = true;
    const csv = rowsToCsv(rows).trim();
    if (csv.length === 0) continue;

    if (total + csv.length > MAX_TEXT_CHARS) {
      const room = MAX_TEXT_CHARS - total;
      if (room > 0) parts.push(`# Sheet: ${ws.name}\n${csv.slice(0, room)}`);
      truncated = true;
      break; // stop before rendering any further sheets
    }
    parts.push(`# Sheet: ${ws.name}\n${csv}`);
    total += csv.length;
  }

  let out = parts.join('\n\n').trim();
  if (truncated && out.length > 0) out += `\n\n${TRUNCATION_NOTE}`;
  return out;
}
