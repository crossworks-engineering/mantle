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
  /** @deprecated Tables v2: sheets are never paginated into parts any more
   *  (sqlite-native storage holds the whole sheet); kept so old callers
   *  type-check. Never set. */
  part?: number;
  partsTotal?: number;
};

const SAMPLE = 50;

// Tables v2: no per-grid row cap here any more. Sheets emit whole (one grid
// per sheet — part-splitting is dead); the import layer enforces the explicit
// TABLE_IMPORT_MAX_ROWS ceiling instead (error, never a silent partial).

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

function parseSheet(name: string, rowsAoA: unknown[][]): ParsedSheet[] {
  // Drop fully-empty rows; the first non-empty row is the header.
  const nonEmpty = rowsAoA.filter((r) => r.some((c) => !isBlank(c)));
  if (nonEmpty.length === 0) return [];

  const headerRow = nonEmpty[0]!;
  const width = nonEmpty.reduce((w, r) => Math.max(w, r.length), headerRow.length);
  const bodyRaw = nonEmpty.slice(1);

  // Keep only columns that carry signal: a non-blank header OR at least one
  // non-blank body cell. A single stray formatted cell out at column 16k would
  // otherwise set `width` and balloon the grid with thousands of empty
  // `Column N`s (real cause of degenerate checklist imports). Columns are kept
  // in source order; placeholder names use the ORIGINAL index so they still map
  // to where they sat in the sheet.
  const keep: number[] = [];
  for (let i = 0; i < width; i++) {
    const headerBlank = isBlank(headerRow[i]);
    const bodyBlank = bodyRaw.every((r) => isBlank(r[i]));
    if (!headerBlank || !bodyBlank) keep.push(i);
  }
  if (keep.length === 0) return [];

  const columns: ParsedColumn[] = keep.map((i) => ({
    name: isBlank(headerRow[i]) ? `Column ${i + 1}` : String(headerRow[i]).trim(),
    type: inferType(bodyRaw.map((r) => r[i])),
  }));

  const allRows = bodyRaw.map((r) => keep.map((i, k) => normalize(r[i], columns[k]!.type)));

  return [{ name, columns, rows: allRows }];
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
    out.push(...parseSheet(name, aoa));
  }
  return out;
}

// ── Pasted tabular TEXT → grid ───────────────────────────────────────────────
// For "build a table from these results" where the data is a blob in the
// conversation (not a file): CSV, TSV, or a markdown pipe table.

function splitMarkdownCells(line: string): string[] {
  let cells = line.split('|');
  if (cells.length && cells[0]!.trim() === '') cells = cells.slice(1);
  if (cells.length && cells[cells.length - 1]!.trim() === '') cells = cells.slice(0, -1);
  return cells.map((c) => c.trim());
}

/** A markdown table separator row: every cell is dashes with optional colons. */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function looksLikeMarkdownTable(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || !lines[0]!.includes('|')) return false;
  return lines.some((l) => l.includes('-') && isSeparatorRow(splitMarkdownCells(l)));
}

function markdownTableToAoa(text: string): string[][] {
  const out: string[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = splitMarkdownCells(line);
    if (isSeparatorRow(cells)) continue; // drop the |---|---| row
    out.push(cells);
  }
  return out;
}

/**
 * Parse a block of pasted tabular text into a grid (one ParsedSheet). Detects:
 *   - a markdown pipe table (`| a | b |` with a `|---|` separator)
 *   - TSV (tab-separated)
 *   - CSV (comma-separated, quote-aware via SheetJS)
 * Returns [] if no table is found. Type inference is the same as file import.
 */
export function parseTextToGrid(text: string): ParsedSheet[] {
  const t = (text ?? '').trim();
  if (!t) return [];
  if (looksLikeMarkdownTable(t)) {
    return parseSheet('Pasted', markdownTableToAoa(t));
  }
  if (t.includes('\t')) {
    const aoa = t.split(/\r?\n/).filter((l) => l.length > 0).map((l) => l.split('\t'));
    return parseSheet('Pasted', aoa);
  }
  // Default: CSV — SheetJS handles quoting/escapes from a buffer.
  return parseSheetToGrid(Buffer.from(t, 'utf-8'));
}
