/**
 * Structured spreadsheet import. Where the text read flattens a workbook (for
 * brain recall), this preserves STRUCTURE: each sheet → typed columns +
 * aligned rows, so a `.xlsx` / `.csv` drop becomes a real typed grid (the
 * Tables feature), not a markdown blob.
 *
 * Dependency-free of the TableDoc model on purpose — @mantle/files sits below
 * @mantle/content. This emits plain shapes (`ParsedSheet`); the caller turns
 * them into a TableDoc via `tableDocFromGrid` in @mantle/content. Column types
 * are inferred by sampling the actual JS values the reader yields (numbers,
 * booleans, Dates), defaulting to text.
 *
 * Two halves, one shape:
 *   - A WORKBOOK (.xlsx/.xlsm, and the legacy .xls/.xlsb converted first) is
 *     read by the parser service (server/parser runs ./sheet-grid.ts); this
 *     module only asks for it through the parser client. Nothing here opens
 *     a zip or a binary workbook.
 *   - Delimited TEXT (CSV/TSV, a pasted markdown table) is plain text and is
 *     read here, in-process, with `fast-csv`: linear, no container to
 *     inflate, the same cost as reading the string.
 *
 * Separate entry point (`@mantle/files/sheet-to-grid`) so the CSV engine only
 * loads when an import actually happens.
 */
import { parse as parseCsvString } from '@fast-csv/parse';

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
    const isNum =
      typeof v === 'number' ||
      (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/[, ]/g, ''))));
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
  if (type === 'checkbox')
    return typeof v === 'boolean' ? v : ['true', '1', 'yes'].includes(String(v).toLowerCase());
  return String(v);
}

/** One sheet's rows (array of arrays, header first) → typed grids. Shared by
 *  the delimited-text read here and the workbook read (./sheet-grid.ts). */
export function parseSheet(name: string, rowsAoA: unknown[][]): ParsedSheet[] {
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
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
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
 * Read delimited text (CSV or TSV) as an array-of-arrays.
 *
 * `fast-csv` rather than a hand-rolled split, because the cases that break a
 * naive parser are exactly the ones a pasted export hits: a quoted field
 * containing the delimiter, a doubled `""` escape, and an embedded newline
 * inside quotes. SheetJS used to cover this; fast-csv is the maintained,
 * purpose-built replacement.
 *
 * Values come back as strings — no coercion here on purpose. `inferType` /
 * `normalize` below do the typing for every source alike, so a CSV column and
 * a workbook column are judged by the same rules.
 */
function readDelimited(text: string, delimiter: string): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const rows: string[][] = [];
    parseCsvString({ delimiter, headers: false, ignoreEmpty: true, discardUnmappedColumns: false })
      .on('data', (row: string[]) => rows.push(row))
      .on('error', reject)
      .on('end', () => resolve(rows))
      .end(text);
  });
}

/** CSV/TSV text → grid, delimiter sniffed from the first line. */
export async function parseDelimited(text: string): Promise<ParsedSheet[]> {
  const t = text.trim();
  if (!t) return [];
  // Sniff on the FIRST line only: a tab anywhere later in a comma-separated
  // file (inside a quoted note, say) must not flip the whole parse.
  const firstLine = t.slice(0, t.indexOf('\n') === -1 ? t.length : t.indexOf('\n'));
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  return parseSheet('Sheet1', await readDelimited(t, delimiter));
}

/**
 * Parse a block of pasted tabular text into a grid (one ParsedSheet). Detects:
 *   - a markdown pipe table (`| a | b |` with a `|---|` separator)
 *   - TSV (tab-separated)
 *   - CSV (comma-separated, quote-aware via fast-csv)
 * Returns [] if no table is found. Type inference is the same as file import.
 */
export async function parseTextToGrid(text: string): Promise<ParsedSheet[]> {
  const t = (text ?? '').trim();
  if (!t) return [];
  if (looksLikeMarkdownTable(t)) {
    return parseSheet('Pasted', markdownTableToAoa(t));
  }
  const sheets = await parseDelimited(t);
  // Pasted text keeps its historical sheet name; a .csv FILE keeps "Sheet1".
  return sheets.map((s) => ({ ...s, name: 'Pasted' }));
}

/** True when the bytes are a container (a zip: OOXML, `.xlsb`) or an OLE2
 *  compound file (legacy `.xls`): a workbook, never delimited text. */
function looksLikeWorkbook(buf: Buffer): boolean {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return true;
  }
  return (
    buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1
  );
}

/**
 * The entry point every INGEST path should use: bytes plus their extension →
 * grids. A workbook (by its bytes or its extension) is read by the parser
 * service; delimited text is read here. One function, so the auto-table
 * pass, the Tables import route and the `table_from_file` tool import
 * identical grids.
 *
 * Throws when the workbook cannot be read (the parser's typed error, see
 * ./parser-client.ts), so the caller reports a real reason rather than "no
 * tabular data found".
 */
export async function parseSpreadsheetToGrid(buf: Buffer, ext: string): Promise<ParsedSheet[]> {
  const e = ext.toLowerCase();
  if (looksLikeWorkbook(buf) || e === 'xlsx' || e === 'xlsm' || e === 'xls' || e === 'xlsb') {
    const { parserGrid } = await import('./parser-client');
    return (await parserGrid(buf, e)).sheets;
  }
  return parseDelimited(buf.toString('utf-8'));
}
