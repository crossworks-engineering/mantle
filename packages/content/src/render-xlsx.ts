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
 * ## Styling
 *
 * The point of exporting to .xlsx rather than CSV is that the file should be
 * READABLE the moment it opens — a frozen, filterable header, columns wide
 * enough for their contents, numbers aligned and formatted, banded rows to
 * follow across. The palette and the sizing rules are shared with the other
 * spreadsheet writer (`./build-sheet.ts`) and live in `./xlsx-style.ts`, which
 * carries the reasoning; nothing here should define a colour of its own.
 *
 * Pure: no DB, no disk. Depends only on the table model + `exceljs`.
 */
import ExcelJS from 'exceljs';
import {
  BAND_FILL,
  HEADER_FILL,
  HEADER_TEXT,
  RULE_COLOR,
  TOTALS_FILL,
  WIDTH_SAMPLE_ROWS,
  alignFor,
  alignment,
  clampWidth,
  displayLength,
  numFmtFor,
  solidFill,
  uniqueSheetName,
} from './xlsx-style';
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
    width: clampWidth(widest[i]!),
  }));

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: HEADER_TEXT } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  for (let c = 1; c <= columns.length; c++) {
    const cell = header.getCell(c);
    cell.fill = solidFill(HEADER_FILL);
    cell.alignment = alignment(aligns[c - 1]!);
  }

  records.forEach((record, r) => {
    const added = ws.addRow(record);
    const banded = r % 2 === 1;
    columns.forEach((_col, i) => {
      const cell = added.getCell(i + 1);
      if (formats[i]) cell.numFmt = formats[i]!;
      cell.alignment = alignment(aligns[i]!);
      if (banded) cell.fill = solidFill(BAND_FILL);
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
      cell.alignment = alignment(aligns[i]!);
      cell.fill = solidFill(TOTALS_FILL);
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
