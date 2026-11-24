/**
 * Structured spreadsheet import. Where the text read flattens a workbook (for
 * brain recall), this preserves STRUCTURE: each sheet → typed columns +
 * aligned rows, so a `.xlsx` / `.csv` drop becomes a real typed grid (the
 * Tables feature), not a markdown blob.
 *
 * Dependency-free of the TableDoc model on purpose — @mantle/files sits below
 * @mantle/content. This emits plain shapes (`ParsedSheet`); the caller turns
 * them into a TableDoc via `tableDocFromGrid` in @mantle/content. Column types
 * are inferred from every actual JS value the reader yields (numbers, booleans,
 * Dates), defaulting to text.
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
import { envNum } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { LEGACY_SHEET_EXTS } from './slug';

/** A coarse column type, expressed as a plain string so this module needn't
 *  import @mantle/content. Validated/narrowed by `tableDocFromGrid`.
 *  `select`: text the table engine indexes (createTab), for an id column
 *  of a Transformer's tab (Links). No Reader infers it. */
export type InferredColumnType = 'text' | 'number' | 'date' | 'datetime' | 'checkbox' | 'select';

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

// Tables v2: no per-grid row cap here any more. Sheets emit whole (one grid
// per sheet — part-splitting is dead); the import layer enforces the explicit
// TABLE_IMPORT_MAX_ROWS ceiling instead (error, never a silent partial).

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** A column's type, decided as its raw cells come in (GridFold): a value
 *  that does not fit its column's type is lost when it is stored
 *  (normalize). It stops looking at the first value that rules out every
 *  type, so a text column costs little. */
class TypeFold {
  private seen = false;
  private allNumber = true;
  private allBool = true;
  private allDate = true;
  private anyTime = false;
  private done = false;
  add(v: unknown): void {
    if (this.done || isBlank(v)) return;
    this.seen = true;
    const isNum =
      typeof v === 'number' ||
      (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/[, ]/g, ''))));
    const isBool = typeof v === 'boolean';
    const isDate = v instanceof Date && !Number.isNaN(v.getTime());
    if (!isNum) this.allNumber = false;
    if (!isBool) this.allBool = false;
    if (!isDate) this.allDate = false;
    // Use UTC: a pure date serial deserialises to UTC midnight regardless of
    // the host timezone, so a local-time check would misread it as a datetime.
    if (isDate && (v.getUTCHours() !== 0 || v.getUTCMinutes() !== 0)) this.anyTime = true;
    if (!this.allNumber && !this.allBool && !this.allDate) this.done = true;
  }
  type(): InferredColumnType {
    if (!this.seen) return 'text';
    if (this.allBool) return 'checkbox';
    if (this.allDate) return this.anyTime ? 'datetime' : 'date';
    if (this.allNumber) return 'number';
    return 'text';
  }
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

/** The columns of a sheet read as a fold (GridFold.shape): each column's
 *  name and type, and `keep`, the place of each in the raw rows. */
export type GridShape = { columns: ParsedColumn[]; keep: number[] };

/**
 * One sheet's rows to its typed grid, a row at a time: the rule of
 * parseSheet, which reads through this, and of a file database read that
 * writes its rows to a file as they come (./sheet-spill.ts), so a sheet of
 * millions of rows is never held. A fully empty row is dropped; the first
 * row that is not is the header. A column is kept when its header or a body
 * cell is not blank (a stray formatted cell out at column 16k would
 * otherwise give thousands of empty `Column N`s), in source order, a
 * placeholder name by its ORIGINAL index. A column's type is decided from
 * every body cell (TypeFold).
 */
export class GridFold {
  private header: readonly unknown[] | null = null;
  private width = 0;
  private filled: boolean[] = [];
  private types: TypeFold[] = [];
  /** The body rows folded in. */
  rows = 0;

  /** What this raw row would be: `blank` (dropped), `header` (the first
   *  row that is not blank) or `body`. Nothing is folded in. */
  kindOf(cells: readonly unknown[]): 'blank' | 'header' | 'body' {
    if (!cells.some((c) => !isBlank(c))) return 'blank';
    return this.header ? 'body' : 'header';
  }

  /** Fold in one raw row (its kind, as {@link kindOf} says). */
  add(cells: readonly unknown[]): 'blank' | 'header' | 'body' {
    if (!cells.some((c) => !isBlank(c))) return 'blank';
    this.width = Math.max(this.width, cells.length);
    if (!this.header) {
      this.header = cells;
      return 'header';
    }
    this.rows += 1;
    for (let i = 0; i < cells.length; i++) {
      const v = cells[i];
      if (isBlank(v)) continue;
      this.filled[i] = true;
      (this.types[i] ??= new TypeFold()).add(v);
    }
    return 'body';
  }

  /** The columns, or null for a sheet with nothing tabular. */
  shape(): GridShape | null {
    const header = this.header;
    if (!header) return null;
    const keep: number[] = [];
    for (let i = 0; i < this.width; i++) {
      if (!isBlank(header[i]) || this.filled[i]) keep.push(i);
    }
    if (keep.length === 0) return null;
    return {
      keep,
      columns: keep.map((i) => ({
        name: isBlank(header[i]) ? `Column ${i + 1}` : String(header[i]).trim(),
        type: this.types[i]?.type() ?? 'text',
      })),
    };
  }
}

/** One raw body row as the grid holds it: the kept cells, each typed. */
export function gridRowOf(
  shape: GridShape,
  cells: readonly unknown[],
): (string | number | boolean | null)[] {
  return shape.keep.map((i, k) => normalize(cells[i], shape.columns[k]!.type));
}

/** {@link gridRowOf} of a row read back from a file of rows (JSON Lines,
 *  ./sheet-spill.ts), where a Date was written as its ISO text: in a date
 *  or datetime column every cell was a Date (TypeFold), so its text is one
 *  again, and the row is typed exactly as the row in hand would be. In any
 *  other column a Date is its ISO text either way (normalize). */
export function gridRowOfLine(
  shape: GridShape,
  cells: readonly unknown[],
): (string | number | boolean | null)[] {
  return shape.keep.map((i, k) => {
    const type = shape.columns[k]!.type;
    const v = cells[i];
    return normalize(
      (type === 'date' || type === 'datetime') && typeof v === 'string' && !isBlank(v)
        ? new Date(v)
        : v,
      type,
    );
  });
}

/** One sheet's rows (array of arrays, header first) → typed grids. Shared by
 *  the delimited-text read here and the workbook read (./sheet-grid.ts). */
export function parseSheet(name: string, rowsAoA: unknown[][]): ParsedSheet[] {
  const fold = new GridFold();
  const body: unknown[][] = [];
  for (const r of rowsAoA) if (fold.add(r) === 'body') body.push(r);
  const shape = fold.shape();
  if (!shape) return [];
  return [{ name, columns: shape.columns, rows: body.map((r) => gridRowOf(shape, r)) }];
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
 * Values come back as strings — no coercion here on purpose. `TypeFold` /
 * `normalize` below do the typing for every source alike, so a CSV column and
 * a workbook column are judged by the same rules.
 */
function readDelimited(
  source: string | Buffer,
  delimiter: string,
  onRow: (row: string[]) => boolean | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopped = false;
    const csv = parseCsvString({
      delimiter,
      headers: false,
      ignoreEmpty: true,
      discardUnmappedColumns: false,
    })
      .on('data', (row: string[]) => {
        if (stopped || onRow(row) !== false) return;
        // The reader asked to stop: the rest of the text is not read.
        stopped = true;
        csv.destroy();
        resolve();
      })
      .on('error', (err) => {
        if (!stopped) reject(err);
      })
      .on('end', () => resolve());
    if (typeof source === 'string') {
      csv.end(source);
      return;
    }
    // Bytes go in slices, so the text is decoded a slice at a time (a file
    // of hundreds of MB is never one string). A slice is a view of the
    // buffer, not a copy.
    for (let at = 0; at < source.length; at += DELIMITED_SLICE_BYTES) {
      csv.write(source.subarray(at, at + DELIMITED_SLICE_BYTES));
    }
    csv.end();
  });
}

/** The bytes of delimited text given to the CSV reader at a time. */
const DELIMITED_SLICE_BYTES = 4 * 1024 * 1024;

/** The cut a {@link RowKeeper} says on the file (./read-cut.ts, docs/files.md
 *  "Read in part"): the rows kept of all the rows, and the limit that cut. */
type RowCutValue = { what: 'rows'; read: number; total: number; limit: number; atLeast?: true };
export type RowCut = {
  database_rows?: RowCutValue;
  database_size?: RowCutValue;
  /** The read stopped at the step's deadline (./sheet-spill.ts): no limit. */
  database_time?: Omit<RowCutValue, 'limit'>;
};

/**
 * The rows a file database read keeps (the package `sheet`'s step; the
 * ingest program): the first rows of the file, in order, up to `maxRows`
 * rows and about `maxBytes` bytes of cell text over all its sheets. A row
 * past either is counted, not kept, and every later row too, so the kept
 * rows are always the head of the file. The cut is said on the file
 * ({@link RowKeeper.cut}); nothing is refused whole.
 *
 * Two limits, one stop: the rows are the import ceiling
 * (TABLE_IMPORT_MAX_ROWS), the bytes the parser's memory and answer and the
 * brain's one write (MANTLE_FILE_DB_CSV_MAX_MB). The bytes are the answer's
 * (see `take`), so a sheet of tiny cells or wide padding stays under the
 * answer cap too.
 */
export class RowKeeper {
  kept = 0;
  total = 0;
  /** Set by a reader that stops at the cut (a workbook stream): `total` is
   *  then the rows seen, at least. */
  atLeast = false;
  private bytes = 0;
  /** The sheet in hand, its widest row and its rows kept: the grid pads
   *  each sheet to its own width. */
  private sheet: unknown = undefined;
  private width = 0;
  private sheetKept = 0;
  private stopped: 'rows' | 'bytes' | null = null;
  constructor(
    readonly maxRows: number,
    readonly maxBytes: number,
  ) {}

  /** Whether to keep this row of `sheet` (any key; one sheet when left
   *  out). Every row is counted. */
  take(cells: readonly unknown[], sheet?: unknown): boolean {
    if (sheet !== this.sheet) {
      this.sheet = sheet;
      this.width = 0;
      this.sheetKept = 0;
    }
    this.total += 1;
    if (this.stopped) return false;
    if (this.kept >= this.maxRows) {
      this.stopped = 'rows';
      return false;
    }
    // The answer's bytes: each cell's UTF-8 plus 3 (quotes and comma), a
    // blank 5 (`null,`), a short row padded to the widest row, and a wider
    // row the padding of every row of its sheet kept before it.
    const width = Math.max(this.width, cells.length);
    let size = (this.sheetKept * (width - this.width) + (width - cells.length)) * 5;
    for (const c of cells) {
      size += (c === null || c === undefined ? 2 : Buffer.byteLength(String(c))) + 3;
    }
    if (this.bytes + size > this.maxBytes) {
      this.stopped = 'bytes';
      return false;
    }
    this.width = width;
    this.sheetKept += 1;
    this.kept += 1;
    this.bytes += size;
    return true;
  }

  /** The cut, or null when every row was kept. */
  cut(): RowCut | null {
    if (!this.stopped) return null;
    const value = {
      what: 'rows' as const,
      read: this.kept,
      total: this.total,
      ...(this.atLeast ? { atLeast: true as const } : {}),
    };
    return this.stopped === 'rows'
      ? { database_rows: { ...value, limit: this.maxRows } }
      : { database_size: { ...value, limit: this.maxBytes } };
  }
}

/** The keeper of a file database read (the package `sheet`'s step): the
 *  import ceiling and the read budget of this box. */
export function fileDbRowKeeper(): RowKeeper {
  return new RowKeeper(
    envNum('TABLE_IMPORT_MAX_ROWS'),
    envNum('MANTLE_FILE_DB_CSV_MAX_MB') * 1024 * 1024,
  );
}

/** The database cuts of a read's cuts (a Reader's write says others too: a
 *  drawing's label counts), or null. */
export function databaseCutOf(cuts: Readonly<Record<string, unknown>> | undefined): RowCut | null {
  const out: RowCut = {};
  for (const key of ['database_rows', 'database_size', 'database_time'] as const) {
    if (cuts?.[key]) out[key] = cuts[key] as RowCutValue;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** CSV/TSV text → grid, delimiter sniffed from the first line. Bytes are
 *  read as a stream, and a {@link RowKeeper} keeps the head of a long file. */
export async function parseDelimited(
  source: string | Buffer,
  keep?: RowKeeper,
): Promise<ParsedSheet[]> {
  const rows: string[][] = [];
  await eachDelimitedRow(source, (row) => {
    if (!keep || keep.take(row)) rows.push(row);
  });
  return rows.length > 0 ? parseSheet('Sheet1', rows) : [];
}

/** Each row of delimited text, as the CSV reader gives it (strings), read
 *  as a stream: the one read of parseDelimited and of a file database read
 *  that writes its rows to a file (./sheet-grid.ts). `onRow` returns false
 *  to stop the read. */
export async function eachDelimitedRow(
  source: string | Buffer,
  onRow: (row: string[]) => boolean | void,
): Promise<void> {
  // A string is trimmed (which drops a BOM too); bytes lose a UTF-8 BOM,
  // and blank lines are skipped by the reader (ignoreEmpty).
  const t =
    typeof source === 'string'
      ? source.trim()
      : source.length >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf
        ? source.subarray(3)
        : source;
  if (t.length === 0) return;
  // Sniff on the FIRST line only: a tab anywhere later in a comma-separated
  // file (inside a quoted note, say) must not flip the whole parse.
  const head = typeof t === 'string' ? t : t.toString('utf-8', 0, Math.min(t.length, 65_536));
  const nl = head.indexOf('\n');
  const firstLine = nl === -1 ? head : head.slice(0, nl);
  await readDelimited(t, firstLine.includes('\t') ? '\t' : ',', onRow);
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

/** Delimited text this process could not read (a stray quote): a verdict on
 *  the document, where any other throw from a read is not. */
export class DelimitedReadError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = 'DelimitedReadError';
  }
}

/** True when the bytes are a container (a zip: OOXML, `.xlsb`) or an OLE2
 *  compound file (legacy `.xls`): a workbook, never delimited text. */
export function looksLikeWorkbook(buf: Buffer): boolean {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return true;
  }
  return (
    buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1
  );
}

/**
 * True when the grid read (`readSpreadsheetGrid` in ./sheet-grid.ts, the
 * package `sheet`'s step) reads these bytes as delimited text: bytes that are
 * no workbook, under any name but a legacy one. A legacy name (`.xls`,
 * `.xlsb`) is converted whatever its bytes, and text bytes fail that
 * conversion, so they are never read as text. The one test of that choice:
 * the reader takes it from here, and so does the early cap in the core
 * (parseFileSheets), so the two cannot drift.
 */
export function readsAsDelimited(buf: Buffer, ext: string): boolean {
  return !LEGACY_SHEET_EXTS.has(ext.toLowerCase()) && !looksLikeWorkbook(buf);
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
  try {
    return await parseDelimited(buf.toString('utf-8'));
  } catch (err) {
    throw new DelimitedReadError(err);
  }
}
