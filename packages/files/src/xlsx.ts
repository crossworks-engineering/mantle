/**
 * Spreadsheet text extraction. Thin wrapper around SheetJS (`xlsx`).
 *
 * Handles both modern `.xlsx` and legacy binary `.xls` (SheetJS
 * auto-detects from the bytes). Each sheet is rendered as CSV under a
 * `# Sheet: <name>` header so the LLM can tell tabs apart; blank rows
 * are dropped. Formulas resolve to their last-computed value, not the
 * formula text.
 *
 * This flattens the workbook to text — fine for "what's in this
 * spreadsheet" recall, not for preserving structure.
 *
 * **Bounded on purpose.** xlsx files routinely carry an inflated used-range:
 * stray formatting or a deleted-but-not-cleared block pushes the sheet
 * dimension out to row 1,048,576 / column XFD even when the real data is a
 * handful of cells. `sheet_to_csv` walks the WHOLE declared range, so an
 * unbounded parse iterates millions of phantom cells — minutes of synchronous,
 * event-loop-blocking work that head-of-line-blocks the single extractor and
 * then emits a multi-MB string. Two prod uploads (a 720 KB and a 591 KB sheet)
 * hung past the 10-minute trace watchdog this way. We cap rows at READ time
 * (`sheetRows`), clamp each sheet's column span, and cap total output bytes.
 * For recall text this is lossless in practice; a genuinely huge sheet is
 * truncated with a trailing marker rather than stalling ingest.
 *
 * Separate entry point (`@mantle/files/xlsx`) so SheetJS is only loaded
 * when a spreadsheet actually shows up.
 */

import * as XLSX from 'xlsx';

/** Rows parsed per sheet. `sheetRows` bounds this at read time, so a phantom
 *  million-row dimension never gets walked. Generous for recall + summary. */
const MAX_ROWS_PER_SHEET = 5_000;
/** Columns rendered per sheet. `sheetRows` doesn't bound width, so we clamp the
 *  range's column span before `sheet_to_csv` to stop a phantom XFD-wide range. */
const MAX_COLS_PER_SHEET = 256;
/** Total CSV chars across all sheets — the backstop against a legitimately
 *  dense workbook (many sheets, each near the row/col caps) emitting an
 *  unbounded body. Aligned with the extractor's `TEXT_STORE_MAX_CHARS` (the
 *  per-node retrievable-text ceiling): the extractor chunks+stores up to that
 *  much for EVERY format, so a spreadsheet shouldn't be a tighter special case
 *  — its rows become individually-embedded `search_chunks` passages like any
 *  other document. Note the LLM bill is bounded SEPARATELY and independently
 *  (the summary prompt is truncated to ~24K chars upstream), so a larger body
 *  here only widens chunk/retrieval coverage, it doesn't grow token cost. The
 *  phantom-range hang is prevented by the row/col caps above, not this one. */
// Char count (compared against `csv.length`), not bytes — aligned with the
// extractor's char-based TEXT_STORE_MAX_CHARS. (Was misnamed MAX_TEXT_BYTES.)
const MAX_TEXT_CHARS = 1_000_000;
const TRUNCATION_NOTE =
  '[spreadsheet truncated for indexing — large or sparse workbook]';

export async function parseXlsx(buf: Buffer): Promise<string> {
  // sheetRows caps rows parsed at READ time (bounds both memory and the range a
  // phantom dimension would otherwise claim). cellFormula/cellHTML off — we keep
  // each cell's cached computed value (what CSV emits), nothing heavier.
  const wb = XLSX.read(buf, {
    type: 'buffer',
    sheetRows: MAX_ROWS_PER_SHEET,
    cellFormula: false,
    cellHTML: false,
  });
  const parts: string[] = [];
  let total = 0;
  let truncated = false;
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet || !sheet['!ref']) continue;
    // `!fullref` is set when sheetRows dropped rows from this sheet — surface
    // that as truncation so the marker is honest about the lost tail.
    if (sheet['!fullref'] && sheet['!fullref'] !== sheet['!ref']) truncated = true;
    // Clamp the column span so sheet_to_csv can't walk a phantom width. We write
    // the clamped range back to `!ref` (which sheet_to_csv reads) rather than
    // passing a `range` option — SheetJS honours that option at runtime but its
    // bundled types don't declare it.
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if (range.e.c - range.s.c + 1 > MAX_COLS_PER_SHEET) {
      range.e.c = range.s.c + MAX_COLS_PER_SHEET - 1;
      sheet['!ref'] = XLSX.utils.encode_range(range);
      truncated = true;
    }
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
    if (csv.length === 0) continue;
    if (total + csv.length > MAX_TEXT_CHARS) {
      const room = MAX_TEXT_CHARS - total;
      if (room > 0) parts.push(`# Sheet: ${name}\n${csv.slice(0, room)}`);
      truncated = true;
      break; // stop before walking any further sheets
    }
    parts.push(`# Sheet: ${name}\n${csv}`);
    total += csv.length;
  }
  let out = parts.join('\n\n').trim();
  if (truncated && out.length > 0) out += `\n\n${TRUNCATION_NOTE}`;
  return out;
}
