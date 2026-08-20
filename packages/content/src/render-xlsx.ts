/**
 * TableDoc → Excel (.xlsx) renderer. The Tables analog of `renderDocx`: it maps
 * the typed grid onto a real worksheet so numbers stay numbers, currency/percent
 * carry number formats, dates are real dates, checkboxes become booleans, and
 * formula columns export their *resolved* values. A trailing totals row mirrors
 * the in-app aggregates.
 *
 * Unlike `tableToText` (lossy GFM for the brain index) this preserves cell types
 * and totals, so the file opens cleanly in Excel, Google Sheets, and LibreOffice
 * Calc — no separate ODS (.ods) path needed.
 *
 * ## A workbook, not a worksheet
 *
 * A Mantle table is a WORKBOOK: since Tables v2.1 every sheet of an imported
 * spreadsheet becomes a tab of the same table. The export used to flatten that
 * to a single worksheet, so downloading a six-tab table silently gave you one
 * tab. `renderXlsxWorkbook` takes the tabs and writes one worksheet each;
 * `renderXlsx` is the one-tab convenience wrapper it is built from.
 *
 * ## Styling is deliberate, and deliberately restrained
 *
 * The point of exporting to .xlsx rather than CSV is that the file should be
 * READABLE the moment it opens — a frozen, filterable header, columns wide
 * enough for their contents, numbers aligned and formatted, banded rows to
 * follow across. So this applies a fixed, neutral house style rather than
 * offering knobs. Two constraints shaped it:
 *
 *   - **It must print and photocopy.** Nothing carries meaning by colour alone;
 *     the header is legible in greyscale and the banding is a hairline tint.
 *   - **It must not fight the reader's theme.** Excel and Sheets have their own
 *     dark modes and their own default cell colour. Any fill we set is fixed,
 *     so we use only tints that keep dark text readable and leave the vast
 *     majority of cells unfilled.
 *
 * Pure: no DB, no disk. Depends only on the table model + `exceljs`.
 */
import ExcelJS from 'exceljs';
import {
  applyView,
  cellIsEmpty,
  computeAggregate,
  resolveCell,
  type CellValue,
  type Column,
  type TableDoc,
} from './table-model';

export type RenderXlsxOptions = {
  /** Worksheet name; defaults to 'Sheet1'. Excel caps sheet names at 31 chars
   *  and forbids `\ / ? * [ ] :` — we sanitise both. */
  title?: string;
};

/** One worksheet of a rendered workbook: a tab's name and its grid. */
export type RenderXlsxSheet = { name: string; doc: TableDoc };

// ── House style ──────────────────────────────────────────────────────────────
// ARGB, exceljs's colour form. Chosen to read in greyscale and to keep black
// text legible, because a fixed fill cannot adapt to the reader's theme.

/** Header band: slate, near-black in greyscale, with white text over it. */
const HEADER_FILL = 'FF1F2937';
const HEADER_TEXT = 'FFFFFFFF';
/** Banding on alternate data rows — a hairline tint, not a colour. */
const BAND_FILL = 'FFF5F6F8';
/** Totals band: one step darker than the banding so it reads as a rule. */
const TOTALS_FILL = 'FFE9ECF1';
const RULE_COLOR = 'FFBFC6D1';

/** Widest column we will auto-size to, in Excel character units. Past this a
 *  long free-text cell stops being a column and starts being a wall; the text
 *  is all still there, the reader just widens it themselves if they care. */
const MAX_AUTO_WIDTH = 60;
const MIN_AUTO_WIDTH = 10;
/** Rows sampled when measuring a column's natural width. Measuring every row
 *  of a 100k-row export to set one number is work nobody sees. */
const WIDTH_SAMPLE_ROWS = 200;

/** Excel number-format string for a typed column, or null to leave it General. */
function numFmtFor(col: Column): string | null {
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
function alignFor(col: Column): 'left' | 'right' | 'center' {
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

function toNumber(v: CellValue): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a resolved cell to the value ExcelJS should store for its column. */
function cellValue(value: CellValue, col: Column): ExcelJS.CellValue {
  if (cellIsEmpty(value)) return null;
  switch (col.type) {
    case 'checkbox':
      return Boolean(value);
    case 'currency':
    case 'percent':
    case 'number':
      return toNumber(value) ?? String(value);
    case 'date':
    case 'datetime': {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? String(value) : d;
    }
    case 'multiselect':
      return Array.isArray(value) ? value.join(', ') : String(value);
    case 'url': {
      // A real hyperlink, so the export is clickable rather than a wall of
      // blue-looking text. Only for values that are actually navigable —
      // anything else stays plain, because a broken link reads as a bug.
      const text = String(value);
      return /^https?:\/\/\S+$/i.test(text) ? { text, hyperlink: text } : text;
    }
    case 'formula': {
      // Resolved formula values are usually numeric; keep them numeric when so.
      const n = toNumber(value);
      return n ?? String(value);
    }
    default:
      return String(value);
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
function numericDisplayLength(n: number, col: Column): number {
  const dp = col.format?.decimals ?? (col.type === 'currency' ? 2 : 0);
  const digits = String(Math.floor(Math.abs(n))).length;
  const separators = Math.max(0, Math.ceil(digits / 3) - 1);
  let len = digits + separators + (dp > 0 ? dp + 1 : 0) + (n < 0 ? 1 : 0);
  if (col.type === 'currency') len += (col.format?.currency ?? 'USD').length + 1;
  if (col.type === 'percent') len += 1;
  return len;
}

/** Rough display length of a stored value, for column sizing. */
function displayLength(v: ExcelJS.CellValue, col: Column, formatted: boolean): number {
  if (v === null || v === undefined) return 0;
  // Matches the numFmt set above: `yyyy-mm-dd` or `yyyy-mm-dd hh:mm`.
  if (v instanceof Date) return col.type === 'datetime' ? 16 : 10;
  if (typeof v === 'object' && 'text' in v) return String(v.text ?? '').length;
  if (typeof v === 'boolean') return 5;
  if (typeof v === 'number' && formatted) return numericDisplayLength(v, col);
  return String(v).length;
}

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (cleaned || 'Sheet1').slice(0, 31);
}

/**
 * Excel refuses two worksheets with the same name, so a workbook whose tabs
 * collide after sanitising (or after the 31-char clip) would throw on write.
 * Suffix duplicates rather than failing the export: the reader can rename a
 * tab, but cannot recover a download that never happened.
 */
function uniqueSheetName(name: string, taken: Set<string>): string {
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
  /* c8 ignore next 2 -- 1000 identically-named tabs is not a reachable state */
  taken.add(base.toLowerCase());
  return base;
}

/** Write one tab onto one worksheet, fully styled. */
function writeSheet(ws: ExcelJS.Worksheet, doc: TableDoc): void {
  const { columns } = doc;
  if (columns.length === 0) return;

  const rows = applyView(doc, null); // document order, all rows
  const formats = columns.map(numFmtFor);
  const aligns = columns.map(alignFor);

  // Values first, widths second: a column is sized from what it actually
  // holds, so an `id` column stays narrow and a `notes` column gets room.
  const widest = columns.map((c) => c.name.length);
  const records: ExcelJS.CellValue[][] = rows.map((row, r) =>
    columns.map((col, i) => {
      const v = cellValue(resolveCell(doc, row, col), col);
      if (r < WIDTH_SAMPLE_ROWS) {
        widest[i] = Math.max(widest[i]!, displayLength(v, col, formats[i] !== null));
      }
      return v;
    }),
  );

  // Totals are computed before the widths are set, because a sum is wider than
  // any single value it sums — a currency column sized to its rows alone shows
  // the total as `#######`.
  const aggregates = doc.aggregates ?? {};
  const hasAggregate = Object.values(aggregates).some((k) => k && k !== 'none');
  const totals: ExcelJS.CellValue[] | null = hasAggregate
    ? columns.map((col) => {
        const kind = aggregates[col.id];
        if (!kind || kind === 'none') return null;
        const v = computeAggregate(doc, col.id, kind, rows);
        return v === null ? '' : (toNumber(v) ?? String(v));
      })
    : null;
  if (totals) {
    // Label the row in the first column that has no aggregate of its own. The
    // old code overwrote column 0 on a FALSY check, so a first column whose sum
    // came to 0 lost its total to the word "Totals".
    const labelAt = columns.findIndex(
      (col) => !aggregates[col.id] || aggregates[col.id] === 'none',
    );
    if (labelAt !== -1) totals[labelAt] = 'Totals';
    totals.forEach((v, i) => {
      widest[i] = Math.max(widest[i]!, displayLength(v, columns[i]!, formats[i] !== null));
    });
  }

  ws.columns = columns.map((c, i) => ({
    header: c.name,
    key: c.id,
    // +3 for the header's filter button and a little breathing room.
    width: Math.min(Math.max(widest[i]! + 3, MIN_AUTO_WIDTH), MAX_AUTO_WIDTH),
  }));

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: HEADER_TEXT } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  for (let c = 1; c <= columns.length; c++) {
    const cell = header.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: 'middle', horizontal: aligns[c - 1] };
  }

  records.forEach((record, r) => {
    const added = ws.addRow(record);
    const banded = r % 2 === 1;
    columns.forEach((_col, i) => {
      const cell = added.getCell(i + 1);
      if (formats[i]) cell.numFmt = formats[i]!;
      cell.alignment = { vertical: 'middle', horizontal: aligns[i] };
      if (banded) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } };
      }
    });
  });

  // Totals row (computed above, so the widths could account for it).
  if (totals) {
    const totalRow = ws.addRow(totals);
    totalRow.font = { bold: true };
    columns.forEach((col, i) => {
      const cell = totalRow.getCell(i + 1);
      const kind = aggregates[col.id];
      // `count` / `filled` / `empty` are row counts, not amounts, so a
      // currency column's totals cell must not inherit its "R #,##0.00".
      if (
        formats[i] &&
        kind &&
        (kind === 'sum' || kind === 'avg' || kind === 'min' || kind === 'max')
      ) {
        cell.numFmt = formats[i]!;
      }
      cell.alignment = { vertical: 'middle', horizontal: aligns[i] };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTALS_FILL } };
      cell.border = { top: { style: 'thin', color: { argb: RULE_COLOR } } };
    });
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }]; // keep the header visible
  // Filter across the header only. Including the totals row would let a filter
  // sort the totals into the data, which is how a "the numbers changed" bug
  // report starts.
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1 + records.length, column: columns.length },
  };
}

/**
 * Render a whole workbook — one worksheet per tab — to .xlsx bytes.
 *
 * An empty `sheets` array still produces a valid (single, blank) workbook
 * rather than throwing: an export is a download, and a reader who asked for a
 * table with nothing in it should get an empty spreadsheet, not an error.
 */
export async function renderXlsxWorkbook(sheets: RenderXlsxSheet[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mantle';
  const taken = new Set<string>();
  if (sheets.length === 0) {
    wb.addWorksheet(uniqueSheetName('Sheet1', taken));
  }
  for (const sheet of sheets) {
    writeSheet(wb.addWorksheet(uniqueSheetName(sheet.name, taken)), sheet.doc);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Render a single TableDoc to a one-worksheet .xlsx workbook. Returns the bytes
 * ready to stream as a download or persist as a file node.
 */
export async function renderXlsx(doc: TableDoc, opts: RenderXlsxOptions = {}): Promise<Buffer> {
  return renderXlsxWorkbook([{ name: opts.title ?? 'Sheet1', doc }]);
}
