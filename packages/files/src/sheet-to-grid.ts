/**
 * Structured spreadsheet import. Where `xlsx.ts` flattens a workbook to text
 * (for brain recall), this preserves STRUCTURE: each sheet → typed columns +
 * aligned rows, so a `.xlsx` / `.csv` drop becomes a real typed grid (the
 * Tables feature), not a markdown blob.
 *
 * Dependency-free of the TableDoc model on purpose — @mantle/files sits below
 * @mantle/content. This emits plain shapes (`ParsedSheet`); the caller turns
 * them into a TableDoc via `tableDocFromGrid` in @mantle/content. Column types
 * are inferred by sampling the actual JS values the reader yields (numbers,
 * booleans, Dates), defaulting to text.
 *
 * Workbooks are read with `exceljs` via ./sheet-read.ts (that module carries
 * the reasoning: why exceljs replaced SheetJS, why the non-streaming reader,
 * and why an uncompressed-size pre-flight replaced the old read cap). Legacy
 * binaries (.xls / .xlsb) are converted to .xlsx first — see ./legacy-sheet.ts
 * — so there is one reader for every spreadsheet. Delimited text (CSV/TSV) has
 * no workbook at all and goes through `fast-csv`.
 *
 * **Async since the exceljs move.** `workbook.xlsx.load()` is promise-based
 * and legacy conversion is a network call to Tika, so both entry points return
 * promises now. Every call site was already in an async context.
 *
 * Separate entry point (`@mantle/files/sheet-to-grid`) so the spreadsheet
 * engine only loads when an import actually happens.
 */
import { parse as parseCsvString } from '@fast-csv/parse';
import { loadWorkbook, worksheetToRows } from './sheet-read';

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
 * The entry point every INGEST path should use: bytes plus their extension →
 * grids, converting a legacy binary first when there is one.
 *
 * `parseSheetToGrid` below stays pure (OOXML or delimited text, no network);
 * this wrapper adds the one step that needs Tika. Having it here rather than
 * repeated at each call site is what keeps the auto-table pass, the Tables
 * import route and the `table_from_file` tool importing identical grids.
 *
 * Throws when a legacy file cannot be converted, so the caller reports a real
 * reason rather than "no tabular data found".
 */
export async function parseSpreadsheetToGrid(buf: Buffer, ext: string): Promise<ParsedSheet[]> {
  const { isLegacySheetExt, convertLegacySheetToXlsx } = await import('./legacy-sheet');
  if (!isLegacySheetExt(ext)) return parseSheetToGrid(buf);

  const { mimeForExt } = await import('./slug');
  const converted = await convertLegacySheetToXlsx(buf, mimeForExt(ext));
  if (!converted) {
    throw new Error(
      `could not convert legacy .${ext} workbook — the document service (Tika) is ` +
        `unavailable or the file is not a readable spreadsheet`,
    );
  }
  return parseSheetToGrid(converted);
}

/**
 * Rows read per sheet for a grid import. Deliberately far above anything a
 * person reviews as a table: the real ceiling for this path is the
 * uncompressed-XML pre-flight in ./sheet-read.ts (~80k rows at the current
 * limit), which fails LOUDLY, and above that the import layer's own
 * TABLE_IMPORT_MAX_ROWS. This cap only exists so `worksheetToRows` has a
 * number; it should never be the thing that bites.
 */
const GRID_MAX_ROWS_PER_SHEET = 1_000_000;
/** Columns read per sheet. Excel's own hard ceiling is 16,384 (XFD). */
const GRID_MAX_COLS_PER_SHEET = 16_384;

/**
 * Parse a spreadsheet into one ParsedSheet per non-empty sheet.
 *
 * Accepts modern workbooks (.xlsx / .xlsm) and delimited text (.csv / .tsv),
 * which yields a single sheet named "Sheet1". Legacy binaries must be
 * converted first (`convertLegacySheetToXlsx`) — `bytesLookLikeOoxml` tells
 * them apart. Returns an empty array if nothing tabular is found.
 *
 * **Throws** rather than degrading: an unreadable workbook (encrypted,
 * corrupt) or one past the in-process size ceiling raises, because a partial
 * or empty grid import would silently look like a successful one. Both call
 * sites already surface the message to the user.
 */
export async function parseSheetToGrid(buf: Buffer): Promise<ParsedSheet[]> {
  if (bytesLookLikeLegacyBiff(buf)) {
    throw new Error(
      'legacy .xls/.xlsb workbook — convert it with convertLegacySheetToXlsx before importing',
    );
  }
  if (!bytesLookLikeOoxml(buf)) return parseDelimited(buf.toString('utf-8'));
  const wb = await loadWorkbook(buf);
  const out: ParsedSheet[] = [];
  for (const ws of wb.worksheets) {
    const { rows } = worksheetToRows(ws, {
      maxRows: GRID_MAX_ROWS_PER_SHEET,
      maxCols: GRID_MAX_COLS_PER_SHEET,
    });
    out.push(...parseSheet(ws.name, rows as unknown[][]));
  }
  return out;
}

/**
 * True when the bytes are an OOXML package (a zip whose first entry starts
 * `PK\x03\x04`). SheetJS used to sniff the format for us and hand back a
 * workbook either way; exceljs reads only OOXML, so the CSV/TSV branch has to
 * be chosen here instead. A legacy `.xls` (BIFF, magic `D0 CF 11 E0`) fails
 * this check too and is correctly NOT treated as text — it never reaches this
 * function, because ./parse.ts converts it upstream.
 */
function bytesLookLikeOoxml(buf: Buffer): boolean {
  return (
    buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
  );
}

/** OLE2 compound-file magic (`D0 CF 11 E0 A1 B1 1A E1`) — a legacy `.xls` or
 *  `.xlsb`. Detected explicitly so such bytes raise a message that names the
 *  fix, instead of being read as UTF-8 and yielding a grid of mojibake. */
function bytesLookLikeLegacyBiff(buf: Buffer): boolean {
  return (
    buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1
  );
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

/** CSV/TSV bytes-or-text → grid, delimiter sniffed from the first line. */
async function parseDelimited(text: string): Promise<ParsedSheet[]> {
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
