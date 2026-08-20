/**
 * Spec → .xlsx. The writer behind the `sheet_build` agent tool.
 *
 * ## Why this exists next to `render-xlsx.ts`
 *
 * An agent could already produce a styled spreadsheet in two steps —
 * `table_create` then `export_node`. That path is right when the thing being
 * made is DATA: a typed grid you will query, filter and add rows to.
 *
 * It is wrong when the thing being made is a DOCUMENT. A quote, an invoice
 * summary, a board pack has a title above the grid and exists to be read once
 * and sent. Forcing that through the table model means creating a stored table
 * nobody wants, in order to get a file. So this renders straight to bytes and
 * stores nothing.
 *
 * The line, for anyone extending either side: **a table is data you query, a
 * sheet is a document you send.**
 *
 * ## The spec is deliberately small
 *
 * The temptation is to expose exceljs. Resist it. An agent given fonts, ARGB
 * fills and a border API will invent a different look every time, and a brain
 * that emits ten differently-styled spreadsheets is worse than one that emits
 * ten identical plain ones. So the spec carries CONTENT and INTENT — what the
 * column means, what to total — and this module owns every visual decision,
 * from the same palette the table export uses (`./xlsx-style.ts`).
 *
 * Three presets are the entire styling surface:
 *   - `report`  (default) slate header, banded rows, ruled totals. For anything
 *               going to another person.
 *   - `plain`   bold header, no fills. For a sheet the recipient will re-style,
 *               pivot, or paste elsewhere — banding fights all three.
 *   - `compact` report without the banding, for dense reference data where the
 *               stripes become noise rather than guidance.
 *
 * ## Rows are objects, not arrays
 *
 * A positional array shifts silently when one value is omitted, and the result
 * is a spreadsheet that is wrong in a way that looks completely fine. Keying
 * each row by column turns that same mistake into a named error before a file
 * is ever written. It costs tokens; it buys the one guarantee that matters for
 * a document somebody will act on.
 *
 * Pure: no DB, no disk, no network.
 */

import ExcelJS from 'exceljs';
import {
  BAND_FILL,
  HEADER_FILL,
  HEADER_TEXT,
  RULE_COLOR,
  TITLE_TEXT,
  TOTALS_FILL,
  WIDTH_SAMPLE_ROWS,
  alignFor,
  alignment,
  clampWidth,
  displayLength,
  numFmtFor,
  solidFill,
  uniqueSheetName,
  type StyledColumn,
} from './xlsx-style';

// ── The spec ─────────────────────────────────────────────────────────────────

export type SheetColumnType =
  'text' | 'number' | 'currency' | 'percent' | 'date' | 'datetime' | 'boolean' | 'url';

export type SheetColumnSpec = {
  /** Stable key each row is keyed by. */
  key: string;
  /** The visible column name. */
  header: string;
  type?: SheetColumnType;
  format?: { currency?: string; decimals?: number };
  /** Overrides the type's default alignment. */
  align?: 'left' | 'right' | 'center';
  /** Fixed width in Excel character units; omit to size from content. */
  width?: number;
};

export type SheetTotalKind = 'sum' | 'avg' | 'count' | 'min' | 'max';

export type SheetSpec = {
  name: string;
  /** Bold heading row written above the table, then a blank spacer row. */
  title?: string;
  style?: 'report' | 'plain' | 'compact';
  columns: SheetColumnSpec[];
  /** One object per row, keyed by column `key`. Missing keys are blank. */
  rows: Record<string, unknown>[];
  /** Column key → aggregate, rendered as a ruled row under the data. */
  totals?: Record<string, SheetTotalKind>;
  /** Freeze this many leading columns as well as the header. */
  freeze_columns?: number;
};

export type WorkbookSpec = { sheets: SheetSpec[] };

// ── Limits ───────────────────────────────────────────────────────────────────
// This tool builds sheets a PERSON reads. Anything past these is data, and data
// belongs in a table (`table_from_file` / `table_create`), which is backed by
// sqlite and paginates. The caps exist so an agent that mistakes one for the
// other is told so, rather than spending a very large number of tokens
// serialising a database into a tool call.

export const MAX_SHEETS = 10;
export const MAX_ROWS_PER_SHEET = 5_000;
export const MAX_ROWS_PER_WORKBOOK = 20_000;
export const MAX_COLUMNS_PER_SHEET = 64;

export class SheetSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetSpecError';
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

const COLUMN_TYPES = new Set<string>([
  'text',
  'number',
  'currency',
  'percent',
  'date',
  'datetime',
  'boolean',
  'url',
]);
const TOTAL_KINDS = new Set<string>(['sum', 'avg', 'count', 'min', 'max']);

/**
 * Check the spec whole before writing anything.
 *
 * Every message names the sheet, and where it can, the offending key — an
 * agent that gets "unknown column key 'amout' on sheet 'Revenue' (expected:
 * client, amount)" fixes it on the next call; one that gets "invalid input"
 * guesses, and usually guesses wrong in a new way.
 */
export function validateWorkbookSpec(spec: WorkbookSpec): void {
  const sheets = spec.sheets;
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new SheetSpecError('at least one sheet is required');
  }
  if (sheets.length > MAX_SHEETS) {
    throw new SheetSpecError(`too many sheets (${sheets.length} > ${MAX_SHEETS})`);
  }

  let totalRows = 0;
  for (const sheet of sheets) {
    const where = `sheet '${sheet?.name ?? '?'}'`;
    if (!sheet?.name || typeof sheet.name !== 'string') {
      throw new SheetSpecError('every sheet needs a name');
    }
    if (!Array.isArray(sheet.columns) || sheet.columns.length === 0) {
      throw new SheetSpecError(`${where}: at least one column is required`);
    }
    if (sheet.columns.length > MAX_COLUMNS_PER_SHEET) {
      throw new SheetSpecError(
        `${where}: too many columns (${sheet.columns.length} > ${MAX_COLUMNS_PER_SHEET})`,
      );
    }
    const keys = new Set<string>();
    for (const col of sheet.columns) {
      if (!col?.key || typeof col.key !== 'string') {
        throw new SheetSpecError(`${where}: every column needs a key`);
      }
      if (keys.has(col.key)) {
        throw new SheetSpecError(`${where}: duplicate column key '${col.key}'`);
      }
      keys.add(col.key);
      if (!col.header || typeof col.header !== 'string') {
        throw new SheetSpecError(`${where}: column '${col.key}' needs a header`);
      }
      if (col.type && !COLUMN_TYPES.has(col.type)) {
        throw new SheetSpecError(
          `${where}: column '${col.key}' has unknown type '${col.type}' ` +
            `(expected: ${[...COLUMN_TYPES].join(', ')})`,
        );
      }
    }

    const rows = sheet.rows ?? [];
    if (!Array.isArray(rows)) throw new SheetSpecError(`${where}: rows must be an array`);
    if (rows.length > MAX_ROWS_PER_SHEET) {
      throw new SheetSpecError(
        `${where}: too many rows (${rows.length} > ${MAX_ROWS_PER_SHEET}). ` +
          `This tool builds sheets a person reads; import data as a table instead.`,
      );
    }
    totalRows += rows.length;

    // Catch a typo'd key rather than silently writing a blank column: a row
    // whose key does not match any column is data the reader will never see.
    const expected = [...keys].join(', ');
    rows.forEach((row, i) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new SheetSpecError(
          `${where}: row ${i + 1} must be an object keyed by column key (got ${
            Array.isArray(row) ? 'an array' : typeof row
          }). Positional arrays are rejected on purpose — a shifted value looks correct.`,
        );
      }
      for (const key of Object.keys(row)) {
        if (!keys.has(key)) {
          throw new SheetSpecError(
            `${where}: row ${i + 1} has unknown column key '${key}' (expected: ${expected})`,
          );
        }
      }
    });

    for (const [key, kind] of Object.entries(sheet.totals ?? {})) {
      if (!keys.has(key)) {
        throw new SheetSpecError(`${where}: totals reference unknown column '${key}'`);
      }
      if (!TOTAL_KINDS.has(kind)) {
        throw new SheetSpecError(
          `${where}: totals['${key}'] is '${kind}' (expected: ${[...TOTAL_KINDS].join(', ')})`,
        );
      }
    }
  }

  if (totalRows > MAX_ROWS_PER_WORKBOOK) {
    throw new SheetSpecError(
      `too many rows across the workbook (${totalRows} > ${MAX_ROWS_PER_WORKBOOK})`,
    );
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** The spec's column type mapped onto the shared style vocabulary. */
function styled(col: SheetColumnSpec): StyledColumn {
  const type = col.type ?? 'text';
  return { type: type === 'boolean' ? 'checkbox' : type, format: col.format };
}

/** Coerce a raw JSON value to what ExcelJS should store for its column. */
function cellValue(raw: unknown, col: SheetColumnSpec): ExcelJS.CellValue {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (col.type ?? 'text') {
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      return ['true', 'yes', '1', 'y'].includes(String(raw).trim().toLowerCase());
    case 'number':
    case 'currency':
    case 'percent': {
      // Accept "1,234.50" and "R 1 234.50" — an agent quoting a number out of a
      // document is the common case, and rejecting it would push the value into
      // a text cell where it silently stops being addable.
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.eE+-]/g, ''));
      return Number.isFinite(n) ? n : String(raw);
    }
    case 'date':
    case 'datetime': {
      const d = raw instanceof Date ? raw : new Date(String(raw));
      return Number.isNaN(d.getTime()) ? String(raw) : d;
    }
    case 'url': {
      const text = String(raw);
      return /^https?:\/\/\S+$/i.test(text) ? { text, hyperlink: text } : text;
    }
    default:
      return Array.isArray(raw) ? raw.join(', ') : String(raw);
  }
}

/** Compute one column's aggregate over the already-coerced cell values. */
function aggregate(values: ExcelJS.CellValue[], kind: SheetTotalKind): number | null {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (kind === 'count') return present.length;
  const numbers = present.filter((v): v is number => typeof v === 'number');
  if (numbers.length === 0) return null;
  switch (kind) {
    case 'sum':
      return numbers.reduce((a, b) => a + b, 0);
    case 'avg':
      return numbers.reduce((a, b) => a + b, 0) / numbers.length;
    case 'min':
      return Math.min(...numbers);
    case 'max':
      return Math.max(...numbers);
  }
}

function writeSheet(ws: ExcelJS.Worksheet, spec: SheetSpec): void {
  const columns = spec.columns;
  const style = spec.style ?? 'report';
  const banded = style === 'report';
  const painted = style !== 'plain';

  const styles = columns.map(styled);
  const formats = styles.map(numFmtFor);
  const aligns = columns.map((c, i) => c.align ?? alignFor(styles[i]!));

  // A title block pushes everything down by two rows: the heading, then a
  // spacer. The spacer is what stops Excel reading the title as part of the
  // table when the reader hits sort or filter.
  const title = spec.title?.trim();
  const headerRowNo = title ? 3 : 1;

  const widest = columns.map((c) => c.header.length);
  const records: ExcelJS.CellValue[][] = spec.rows.map((row, r) =>
    columns.map((col, i) => {
      const v = cellValue(row[col.key], col);
      if (r < WIDTH_SAMPLE_ROWS) {
        widest[i] = Math.max(widest[i]!, displayLength(v, styles[i]!, formats[i] !== null));
      }
      return v;
    }),
  );

  // Totals before widths: a sum is wider than any single value it sums, and a
  // column sized to its rows alone shows the total as `#######`.
  const totalsSpec = spec.totals ?? {};
  const hasTotals = Object.keys(totalsSpec).length > 0;
  const totals: ExcelJS.CellValue[] | null = hasTotals
    ? columns.map((col, i) => {
        const kind = totalsSpec[col.key];
        if (!kind) return null;
        return aggregate(
          records.map((rec) => rec[i]!),
          kind,
        );
      })
    : null;
  if (totals) {
    const labelAt = columns.findIndex((col) => !totalsSpec[col.key]);
    if (labelAt !== -1) totals[labelAt] = 'Totals';
    totals.forEach((v, i) => {
      widest[i] = Math.max(widest[i]!, displayLength(v, styles[i]!, formats[i] !== null));
    });
  }

  ws.columns = columns.map((c, i) => ({
    key: c.key,
    width: c.width ?? clampWidth(widest[i]!),
  }));

  if (title) {
    const titleCell = ws.getCell(1, 1);
    titleCell.value = title;
    titleCell.font = { bold: true, size: 14, color: { argb: TITLE_TEXT } };
    titleCell.alignment = alignment('left');
    ws.getRow(1).height = 26;
    // Merge across the table so a long title does not spill into, and appear
    // to belong to, the second column.
    if (columns.length > 1) ws.mergeCells(1, 1, 1, columns.length);
  }

  const header = ws.getRow(headerRowNo);
  columns.forEach((col, i) => {
    const cell = header.getCell(i + 1);
    cell.value = col.header;
    cell.font = painted
      ? { bold: true, color: { argb: HEADER_TEXT } }
      : { bold: true, color: { argb: TITLE_TEXT } };
    cell.alignment = alignment(aligns[i]!);
    if (painted) cell.fill = solidFill(HEADER_FILL);
    else cell.border = { bottom: { style: 'thin', color: { argb: RULE_COLOR } } };
  });
  header.height = 22;

  records.forEach((record, r) => {
    const row = ws.getRow(headerRowNo + 1 + r);
    columns.forEach((_col, i) => {
      const cell = row.getCell(i + 1);
      cell.value = record[i]!;
      if (formats[i]) cell.numFmt = formats[i]!;
      cell.alignment = alignment(aligns[i]!);
      if (banded && r % 2 === 1) cell.fill = solidFill(BAND_FILL);
    });
    row.commit();
  });

  if (totals) {
    const row = ws.getRow(headerRowNo + 1 + records.length);
    columns.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      cell.value = totals[i]!;
      const kind = totalsSpec[col.key];
      // `count` is a row count, not an amount, so a currency column's totals
      // cell must not inherit its "USD #,##0.00".
      if (formats[i] && kind && kind !== 'count') cell.numFmt = formats[i]!;
      cell.alignment = alignment(aligns[i]!);
      if (painted) cell.fill = solidFill(TOTALS_FILL);
      cell.font = { bold: true };
      cell.border = { top: { style: 'thin', color: { argb: RULE_COLOR } } };
    });
    row.commit();
  }

  // Freeze the header, plus any leading columns the caller pinned. Clamped to
  // one short of the full width — freezing every column freezes the sheet.
  const xSplit = Math.max(0, Math.min(spec.freeze_columns ?? 0, columns.length - 1));
  ws.views = [{ state: 'frozen', ySplit: headerRowNo, xSplit }];
  // Filter across the header + data, never the totals row: a filter that can
  // sort the totals into the data is how a "the numbers changed" report starts.
  ws.autoFilter = {
    from: { row: headerRowNo, column: 1 },
    to: { row: headerRowNo + records.length, column: columns.length },
  };
}

/**
 * Render a workbook spec to .xlsx bytes.
 *
 * Throws {@link SheetSpecError} with a message naming the sheet and key at
 * fault; the caller passes that straight back to the agent, which is what makes
 * a second attempt land.
 */
export async function buildSheet(spec: WorkbookSpec): Promise<Buffer> {
  validateWorkbookSpec(spec);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mantle';
  const taken = new Set<string>();
  for (const sheet of spec.sheets) {
    writeSheet(wb.addWorksheet(uniqueSheetName(sheet.name, taken)), sheet);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
