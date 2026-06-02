/**
 * Structured spreadsheet import. Where `xlsx.ts` flattens a workbook to text
 * (for brain recall), this preserves STRUCTURE: each sheet → typed columns +
 * aligned rows, so a `.xlsx` / `.csv` drop becomes a real typed grid (the
 * Tables feature), not a markdown blob.
 *
 * Dependency-free of the TableDoc model on purpose — @mantle/files sits below
 * @mantle/content. This emits plain shapes (`ParsedSheet`); the caller turns
 * them into a TableDoc via `tableDocFromGrid` in @mantle/content. Column types
 * are inferred by sampling the actual JS values SheetJS yields (numbers,
 * booleans, Dates), defaulting to text.
 *
 * Separate entry point (`@mantle/files/sheet-to-grid`) so SheetJS only loads
 * when an import actually happens.
 */
import * as XLSX from 'xlsx';

/** A coarse column type, expressed as a plain string so this module needn't
 *  import @mantle/content. Validated/narrowed by `tableDocFromGrid`. */
export type InferredColumnType = 'text' | 'number' | 'date' | 'datetime' | 'checkbox';

export type ParsedColumn = { name: string; type: InferredColumnType };

export type ParsedSheet = {
  name: string;
  columns: ParsedColumn[];
  /** Row values aligned to `columns` (same length, padded with null). Values
   *  are already typed: number | boolean | ISO-date string | text | null. */
  rows: (string | number | boolean | null)[][];
};

const SAMPLE = 50;

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Decide a column's type from a sample of raw cell values. */
function inferType(values: unknown[]): InferredColumnType {
  const sample = values.filter((v) => !isBlank(v)).slice(0, SAMPLE);
  if (sample.length === 0) return 'text';
  let allNumber = true;
  let allBool = true;
  let allDate = true;
  let anyTime = false;
  for (const v of sample) {
    const isNum = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/[, ]/g, ''))));
    const isBool = typeof v === 'boolean';
    const isDate = v instanceof Date && !Number.isNaN(v.getTime());
    if (!isNum) allNumber = false;
    if (!isBool) allBool = false;
    if (!isDate) allDate = false;
    // Use UTC: a pure date serial deserialises to UTC midnight regardless of
    // the host timezone, so a local-time check would misread it as a datetime.
    if (isDate && (v.getUTCHours() !== 0 || v.getUTCMinutes() !== 0)) anyTime = true;
  }
  if (allBool) return 'checkbox';
  if (allDate) return anyTime ? 'datetime' : 'date';
  if (allNumber) return 'number';
  return 'text';
}

/** Normalise a raw cell into the storage value for its inferred type. */
function normalize(v: unknown, type: InferredColumnType): string | number | boolean | null {
  if (isBlank(v)) return null;
  if (v instanceof Date) {
    return type === 'date' ? v.toISOString().slice(0, 10) : v.toISOString();
  }
  if (type === 'number') {
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[, ]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'checkbox') return typeof v === 'boolean' ? v : ['true', '1', 'yes'].includes(String(v).toLowerCase());
  return String(v);
}

function parseSheet(name: string, rowsAoA: unknown[][]): ParsedSheet | null {
  // Drop fully-empty leading rows; the first non-empty row is the header.
  const nonEmpty = rowsAoA.filter((r) => r.some((c) => !isBlank(c)));
  if (nonEmpty.length === 0) return null;

  const headerRow = nonEmpty[0]!;
  const width = nonEmpty.reduce((w, r) => Math.max(w, r.length), headerRow.length);
  const headers: string[] = [];
  for (let i = 0; i < width; i++) {
    const h = headerRow[i];
    headers.push(isBlank(h) ? `Column ${i + 1}` : String(h).trim());
  }

  const bodyRaw = nonEmpty.slice(1);
  // Column-major samples for type inference.
  const columns: ParsedColumn[] = headers.map((hName, i) => ({
    name: hName,
    type: inferType(bodyRaw.map((r) => r[i])),
  }));

  const rows = bodyRaw.map((r) => columns.map((c, i) => normalize(r[i], c.type)));
  return { name, columns, rows };
}

/**
 * Parse a workbook (xlsx/xls/csv) into one ParsedSheet per non-empty sheet.
 * CSV yields a single sheet named "Sheet1". Returns an empty array if nothing
 * tabular is found.
 */
export function parseSheetToGrid(buf: Buffer): ParsedSheet[] {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const out: ParsedSheet[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      blankrows: false,
      defval: null,
    });
    const parsed = parseSheet(name, aoa);
    if (parsed) out.push(parsed);
  }
  return out;
}
