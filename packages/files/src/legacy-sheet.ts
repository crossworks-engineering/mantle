/**
 * Legacy spreadsheet → modern `.xlsx`, converted at the door. Runs in the
 * parser service (server/parser) only.
 *
 * exceljs reads OOXML only: `.xlsx` and `.xlsm`. It cannot read the old binary
 * formats: BIFF `.xls` (Excel 97-2003) or `.xlsb`. Rather than keep a second
 * spreadsheet engine alive for two formats, we CONVERT them: legacy bytes
 * in, real `.xlsx` bytes out, and from that point there is exactly one
 * spreadsheet reader. The text read (./read-document.ts) and the grid read
 * (./sheet-grid.ts) both run the converted buffer through the ordinary
 * exceljs path, so legacy files get the same caps, the same cell coercion
 * and the same output shape as anything else.
 *
 * ## The converter is anydoc
 *
 * anydoc (./anydoc.ts) reads BIFF and `.xlsb` and gives each sheet as a
 * heading and a table, which we rebuild as a workbook with exceljs. (Until
 * the parser service, Apache Tika's XHTML rendering did this job.)
 *
 * What conversion costs: anydoc gives a RENDERING, not the cell model, so
 * type fidelity is reduced. Numbers survive as numeric text and are written
 * back as numbers ({@link numericOrText}); a date arrives as ISO text, which
 * the grid's type inference re-reads as a date.
 *
 * ## Size
 *
 * A rendering is a full rectangle: a workbook holding only A1 and GR10000
 * renders as 10,000 x 200 cells, almost all empty. Each laid-out sheet is
 * checked against {@link MAX_LEGACY_CELLS} before a row is copied out, and a
 * workbook whose every sheet is past it is refused as too large. That check
 * runs after anydoc has laid the sheet out, so it is a cheap refusal for the
 * merely big, not a guard: a workbook whose cell records (or a lying
 * DIMENSIONS record) make anydoc's own layout run out of memory is stopped
 * by the parser container's memory limit, and the parser answers `crashed`.
 *
 * Unreadable bytes or no tables: `null`, and the caller degrades to whatever
 * it would have done for an unreadable file.
 */

import ExcelJS from 'exceljs';
import type { RefusedSheet } from './anydoc';
import { DocumentTooLargeError, isDocumentTooLarge } from './read-limit';
import { LEGACY_SHEET_EXTS } from './slug';

/** Cells (rows x widest row, empty ones included) a legacy workbook may
 *  rebuild to, over all its sheets. 1,000,000 is 1,000 rows x 1,000 columns
 *  or 100,000 x 10: past the 5,000-row text cap (./xlsx.ts) and past what a
 *  person reviews as a table. */
export const MAX_LEGACY_CELLS = 1_000_000;

/** A converted workbook, and the sheets left out of it for their size. */
export type LegacyConversion = { xlsx: Buffer; refused: RefusedSheet[] };

/** True when this extension needs converting before the exceljs path. */
export function isLegacySheetExt(ext: string): boolean {
  return LEGACY_SHEET_EXTS.has(ext.toLowerCase());
}

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

/** One line per refused sheet, for the note and the refusal. */
export function describeRefused(refused: RefusedSheet[]): string {
  return refused
    .map(
      (r) =>
        `sheet "${r.name}" (${r.rows.toLocaleString('en-US')} rows x ${r.cols.toLocaleString('en-US')} columns)`,
    )
    .join(', ');
}

type LegacySheet = { name: string; rows: string[][] };

/** Keep the sheets that fit the cell budget, in order; refuse the rest. */
function withinBudget(
  sheets: LegacySheet[],
  refused: RefusedSheet[],
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

/** `"12.5"` → `12.5`; anything else stays the string (empty → null). */
function numericOrText(text: string): string | number | null {
  if (text === '') return null;
  // Deliberately strict: no thousands separators, no currency symbols. A
  // rendered "1,234" stays text here and is re-inferred downstream by
  // the grid reader, which already knows how to strip separators.
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return text;
  const n = Number(text);
  return Number.isFinite(n) ? n : text;
}

/**
 * Convert legacy spreadsheet bytes to a real `.xlsx` buffer, with the sheets
 * refused for their size, or `null` when the file cannot be converted (an
 * Excel 2007 beta `.xlsb`, a corrupt record, an encrypted workbook).
 *
 * An OOXML workbook under a legacy name comes back as it is (it already IS
 * an `.xlsx`). Throws a {@link DocumentTooLargeError} when sheets were read
 * but every one was past the cell budget, or anydoc hit its own limit.
 */
export async function convertLegacySheetToXlsx(bytes: Buffer): Promise<LegacyConversion | null> {
  if (isOoxmlWorkbook(bytes)) return { xlsx: bytes, refused: [] };
  let read;
  try {
    const { anydocSheets } = await import('./anydoc');
    read = await anydocSheets(bytes, 'xls', MAX_LEGACY_CELLS);
  } catch (err) {
    if (isDocumentTooLarge(err)) throw err;
    return null;
  }
  const nonEmpty = read.sheets.filter((s) => s.rows.some((r) => r.some((c) => c !== '')));
  const { kept, refused } = withinBudget(nonEmpty, read.refused);
  if (kept.length === 0) {
    if (refused.length > 0) {
      throw new DocumentTooLargeError(
        `The workbook is too large to read: ${describeRefused(refused)} ${refused.length === 1 ? 'is' : 'are'} past the ${MAX_LEGACY_CELLS.toLocaleString('en-US')}-cell limit for a legacy spreadsheet. Save it as .xlsx to read it in full.`,
      );
    }
    return null;
  }
  const wb = new ExcelJS.Workbook();
  const used = new Set<string>();
  for (const sheet of kept) {
    // Excel caps sheet names at 31 chars and forbids \ / ? * [ ] : and two
    // sheets of one name (exceljs throws on the second).
    const base = (sheet.name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet';
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    }
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    for (const row of sheet.rows) ws.addRow(row.map(numericOrText));
  }
  return { xlsx: Buffer.from(await wb.xlsx.writeBuffer()), refused };
}
