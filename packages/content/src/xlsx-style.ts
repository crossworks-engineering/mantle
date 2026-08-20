/**
 * The house style for every .xlsx this system writes, in one place.
 *
 * Two renderers produce spreadsheets: `render-xlsx.ts` (a stored table
 * downloaded as a workbook) and `build-sheet.ts` (an agent composing a sheet
 * from scratch). If each carried its own palette they would drift, and the
 * first person to notice would be a client holding two files from the same
 * brain that do not look like they came from the same place. So the colours,
 * the sizing rules and the type-driven formatting live here and both import
 * them.
 *
 * ## Why these colours
 *
 * ARGB, exceljs's colour form. A fill written into a file is FIXED — it cannot
 * respond to the reader's theme, and Excel, Sheets and LibreOffice all have
 * dark modes now. So two rules constrain the palette:
 *
 *   - **Nothing carries meaning by colour alone**, and the whole thing has to
 *     survive being printed in greyscale. The header reads as near-black, the
 *     banding as a barely-there tint.
 *   - **Most cells stay unfilled.** The more of the sheet we paint, the more of
 *     the reader's own theme we override, and the worse it looks in their dark
 *     mode. Fills mark structure (header, banding, totals) and nothing else.
 */

import type ExcelJS from 'exceljs';

/** Header band: slate, near-black in greyscale, with white text over it. */
export const HEADER_FILL = 'FF1F2937';
export const HEADER_TEXT = 'FFFFFFFF';
/** Banding on alternate data rows — a hairline tint, not a colour. */
export const BAND_FILL = 'FFF5F6F8';
/** Totals band: one step darker than the banding so it reads as a rule. */
export const TOTALS_FILL = 'FFE9ECF1';
/** Hairline rule above a totals row, and under a title block. */
export const RULE_COLOR = 'FFBFC6D1';
/** Title-block text: dark enough to lead, not as heavy as the header band. */
export const TITLE_TEXT = 'FF111827';

/** Widest column we will auto-size to, in Excel character units. Past this a
 *  long free-text cell stops being a column and starts being a wall; the text
 *  is all still there, the reader just widens it themselves if they care. */
export const MAX_AUTO_WIDTH = 60;
export const MIN_AUTO_WIDTH = 10;
/** Rows sampled when measuring a column's natural width. Measuring every row
 *  of a 100k-row export to set one number is work nobody sees. */
export const WIDTH_SAMPLE_ROWS = 200;
/** Padding added to the widest measured value: room for the header's filter
 *  button, plus a little air. */
export const WIDTH_PADDING = 3;

/** The column shape both renderers can describe a column with — the subset of
 *  the table model's `Column` that actually drives presentation. */
export type StyledColumnType =
  | 'text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'datetime'
  | 'checkbox'
  | 'url'
  | 'formula'
  | 'select'
  | 'multiselect'
  | 'reference';

export type StyledColumn = {
  type: StyledColumnType;
  format?: { currency?: string; decimals?: number };
};

/** Excel number-format string for a typed column, or null to leave it General. */
export function numFmtFor(col: StyledColumn): string | null {
  const dp = col.format?.decimals;
  switch (col.type) {
    case 'currency': {
      const code = col.format?.currency ?? 'USD';
      const digits = dp ?? 2;
      return `"${code}" #,##0${digits > 0 ? '.' + '0'.repeat(digits) : ''}`;
    }
    case 'percent':
      // Store the raw number (42 → "42%"), so use a literal % rather than
      // Excel's "0%" which would multiply by 100.
      return `#,##0${dp != null && dp > 0 ? '.' + '0'.repeat(dp) : ''}"%"`;
    case 'number':
      return dp != null ? `#,##0${dp > 0 ? '.' + '0'.repeat(dp) : ''}` : null;
    // Without an explicit format a real date cell renders as whatever the
    // reader's locale defaults to, which for a shared export means two people
    // reading 03/04 as different days. ISO is unambiguous everywhere.
    case 'date':
      return 'yyyy-mm-dd';
    case 'datetime':
      return 'yyyy-mm-dd hh:mm';
    default:
      return null;
  }
}

/** Horizontal alignment for a column's data cells. */
export function alignFor(col: StyledColumn): 'left' | 'right' | 'center' {
  switch (col.type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'formula':
      return 'right';
    case 'checkbox':
      return 'center';
    case 'date':
    case 'datetime':
      return 'right'; // dates are ordinal; right-aligned they compare by eye
    default:
      return 'left';
  }
}

/**
 * How wide a number will be once Excel has FORMATTED it, in characters.
 *
 * Sizing from the stored value is the trap here: `12500` is five characters,
 * but with a currency format it renders as `USD 12,500.00`, which is thirteen.
 * A column sized for the stored value is too narrow for what it displays, and
 * Excel's response to a too-narrow numeric cell is `#######` — the export looks
 * broken on open, and the number is not even wrong, just invisible.
 */
export function numericDisplayLength(n: number, col: StyledColumn): number {
  const dp = col.format?.decimals ?? (col.type === 'currency' ? 2 : 0);
  const digits = String(Math.floor(Math.abs(n))).length;
  const separators = Math.max(0, Math.ceil(digits / 3) - 1);
  let len = digits + separators + (dp > 0 ? dp + 1 : 0) + (n < 0 ? 1 : 0);
  if (col.type === 'currency') len += (col.format?.currency ?? 'USD').length + 1;
  if (col.type === 'percent') len += 1;
  return len;
}

/** Rough display length of a stored value, for column sizing. */
export function displayLength(v: ExcelJS.CellValue, col: StyledColumn, formatted: boolean): number {
  if (v === null || v === undefined) return 0;
  // Matches the numFmt above: `yyyy-mm-dd` or `yyyy-mm-dd hh:mm`.
  if (v instanceof Date) return col.type === 'datetime' ? 16 : 10;
  if (typeof v === 'object' && 'text' in v) return String(v.text ?? '').length;
  if (typeof v === 'boolean') return 5;
  if (typeof v === 'number' && formatted) return numericDisplayLength(v, col);
  return String(v).length;
}

/** Clamp a measured natural width into the sizing band. */
export function clampWidth(measured: number): number {
  return Math.min(Math.max(measured + WIDTH_PADDING, MIN_AUTO_WIDTH), MAX_AUTO_WIDTH);
}

/** A solid fill in one of the house colours. */
export function solidFill(argb: string): ExcelJS.FillPattern {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

/** Cell alignment with the house vertical default. */
export function alignment(horizontal: 'left' | 'right' | 'center'): Partial<ExcelJS.Alignment> {
  return { vertical: 'middle', horizontal };
}

/** Excel caps sheet names at 31 chars and forbids `\ / ? * [ ] :`. */
export function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (cleaned || 'Sheet1').slice(0, 31);
}

/**
 * Excel refuses two worksheets with the same name, so a workbook whose sheets
 * collide after sanitising (or after the 31-char clip) would throw on write.
 * Suffix duplicates rather than failing: the reader can rename a tab, but
 * cannot recover a download that never happened.
 *
 * `taken` is mutated — pass one set per workbook.
 */
export function uniqueSheetName(name: string, taken: Set<string>): string {
  const base = sanitizeSheetName(name);
  if (!taken.has(base.toLowerCase())) {
    taken.add(base.toLowerCase());
    return base;
  }
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const candidate = base.slice(0, 31 - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  /* c8 ignore next 2 -- 1000 identically-named sheets is not a reachable state */
  taken.add(base.toLowerCase());
  return base;
}
