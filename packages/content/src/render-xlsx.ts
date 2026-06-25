/**
 * TableDoc → Excel (.xlsx) renderer. The Tables analog of `renderDocx`: it maps
 * the typed grid onto a real worksheet so numbers stay numbers, currency/percent
 * carry number formats, checkboxes become booleans, and formula columns export
 * their *resolved* values. A trailing totals row mirrors the in-app aggregates.
 *
 * Unlike `tableToText` (lossy GFM for the brain index) this preserves cell types
 * and totals, so the file opens cleanly in Excel, Google Sheets, and LibreOffice
 * Calc — no separate ODS (.ods) path needed.
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

/** Excel number-format string for a typed numeric column. */
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
    default:
      return null;
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
    case 'formula': {
      // Resolved formula values are usually numeric; keep them numeric when so.
      const n = toNumber(value);
      return n ?? String(value);
    }
    default:
      return String(value);
  }
}

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (cleaned || 'Sheet1').slice(0, 31);
}

/**
 * Render a TableDoc to an .xlsx workbook (single worksheet). Returns the bytes
 * ready to stream as a download or persist as a file node.
 */
export async function renderXlsx(doc: TableDoc, opts: RenderXlsxOptions = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mantle';
  const ws = wb.addWorksheet(sanitizeSheetName(opts.title ?? 'Sheet1'));

  const { columns } = doc;
  if (columns.length === 0) {
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // Header row — bold, with sane default widths.
  ws.columns = columns.map((c) => ({
    header: c.name,
    key: c.id,
    width: Math.min(Math.max(c.name.length + 2, 12), 48),
  }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };

  const rows = applyView(doc, null); // document order, all rows
  for (const row of rows) {
    const record: Record<string, ExcelJS.CellValue> = {};
    for (const col of columns) record[col.id] = cellValue(resolveCell(doc, row, col), col);
    const added = ws.addRow(record);
    // Apply number formats per typed column.
    columns.forEach((col, idx) => {
      const fmt = numFmtFor(col);
      if (fmt) added.getCell(idx + 1).numFmt = fmt;
    });
  }

  // Totals row when any column carries an aggregate (mirrors tableToText).
  const aggregates = doc.aggregates ?? {};
  if (Object.keys(aggregates).length > 0) {
    const totals: Record<string, ExcelJS.CellValue> = {};
    columns.forEach((col, idx) => {
      const kind = aggregates[col.id];
      if (!kind || kind === 'none') {
        if (idx === 0) totals[col.id] = 'Totals';
        return;
      }
      const v = computeAggregate(doc, col.id, kind, rows);
      totals[col.id] = v === null ? '' : (toNumber(v) ?? String(v));
    });
    if (!totals[columns[0]!.id]) totals[columns[0]!.id] = 'Totals';
    const totalRow = ws.addRow(totals);
    totalRow.font = { bold: true };
    columns.forEach((col, idx) => {
      const fmt = numFmtFor(col);
      if (fmt && aggregates[col.id] && aggregates[col.id] !== 'none') {
        totalRow.getCell(idx + 1).numFmt = fmt;
      }
    });
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }]; // keep the header visible
  return Buffer.from(await wb.xlsx.writeBuffer());
}
