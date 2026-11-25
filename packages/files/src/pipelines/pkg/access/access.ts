/**
 * A Microsoft Access database (`.accdb`, Access 2007 and later; `.mdb`,
 * Access 97 to 2003) for the Reader `access` (./step.ts): every user table
 * to one tab, with the type of each of its own columns, and the file's text
 * (a summary of its tables, then the first rows of each). Read with
 * mdb-reader 3.2.2 (MIT, pure JavaScript, Jet 3, Jet 4 and ACE 12 to 17), on
 * Bun in the parser job `pipelineRun`. No model is asked.
 *
 * - The rows a database keeps are the file database read's (fileDbRowKeeper,
 *   the `sheet` Reader's keeper): the first rows up to the import ceiling and
 *   the read budget of cell text, the rest counted, the cut said. A table is
 *   read in batches of {@link BATCH_ROWS}, and the read stops at the cut, so
 *   memory holds the file, the kept rows and one batch.
 * - Columns with no value to keep in a cell (an attachment, a list of many
 *   values, an OLE object, a binary field) and calculated columns are not
 *   read: named in the description and the text, and said as the cut
 *   `access_columns` (the file is partial). mdb-reader reads a complex column
 *   (attachments, many values) as attachments only, and reads its whole
 *   hidden table again for every row; an OLE object can be megabytes a cell;
 *   a calculated column's stored value is wrapped and mdb-reader does not
 *   unwrap it (patches/mdb-reader@3.2.2.patch names such a column). A
 *   calculated value is made from the other columns, which are read.
 * - A file with a password is not read (an ACE file encrypted with one, or
 *   a Jet file with a database password): its text says so, and the cut
 *   `access_password` gives the reason on the file.
 * - A damaged file: a table whose definition cannot be read is named (the
 *   cut `access_tables`); a batch that cannot be read is read again one row
 *   at a time, and the rows that cannot be read, or that its row count has
 *   and the read did not find, are counted (the cut `access_rows`).
 * - The text keeps at most {@link TEXT_ROWS_PER_TABLE} rows a table and
 *   {@link TEXT_MAX_CHARS} characters, the text read's caps of a workbook
 *   (../../../xlsx.ts); the cut `access_text` says how many of the kept rows
 *   are in it. Every kept row is in the database for file_sql.
 */
import MDBReader from 'mdb-reader';
import type { ReadCutValue } from '../../../read-cut';
import type {
  InferredColumnType,
  ParsedColumn,
  ParsedSheet,
  RowKeeper,
} from '../../../sheet-to-grid';

/** Rows one `getData` call decodes. */
export const BATCH_ROWS = 1_000;
/** Rows of a table in the text (the workbook text read's cap). */
export const TEXT_ROWS_PER_TABLE = 5_000;
/** Characters of the whole text (the workbook text read's cap). */
export const TEXT_MAX_CHARS = 1_000_000;
/** Names one list of the description holds (its cap is 4,000 characters). */
const NAMES_LISTED = 10;
/** Digits a double holds exactly. */
const EXACT_DIGITS = 15;

/** A column of mdb-reader (its `getColumns()`), the fields this reads.
 *  `calculated` is the repo's patch of mdb-reader. */
type AccessColumn = { name: string; type: string; calculated?: boolean };
type Cell = string | number | boolean | null;
/** A column read: its tab type, and `decimal` for a Currency or Decimal
 *  column, whose values come as text and stay text until the read knows a
 *  double holds every one ({@link exactNumbers}). */
type Read = { name: string; type: InferredColumnType; decimal?: true };
type Row = Record<string, unknown>;

/** What a read of an Access file gave. */
export type AccessRead =
  | { locked: true }
  | {
      locked: false;
      tabs: ParsedSheet[];
      text: string;
      description: string;
      readCuts: Record<string, ReadCutValue>;
    };

/**
 * The tab type of an Access column, or null for one not read (attachments,
 * many values, OLE, binary, a calculated column). A Large Number (bigint)
 * is text: a double does not hold every one.
 */
export function columnTypeOf(c: AccessColumn): InferredColumnType | null {
  if (c.calculated) return null;
  switch (c.type) {
    case 'boolean':
      return 'checkbox';
    case 'byte':
    case 'integer':
    case 'long':
    case 'float':
    case 'double':
    case 'currency':
    case 'numeric':
      return 'number';
    case 'datetime':
      return 'datetime';
    case 'text':
    case 'memo':
    case 'repid':
    case 'bigint':
    case 'datetimextended':
      return 'text';
    default:
      return null;
  }
}

/** The days of Access's day 0 (1899-12-30) after 1970-01-01. */
const ACCESS_EPOCH_DAYS = 25569;
const DAY_MS = 86_400_000;

/**
 * A date before 1899-12-30 with a time of day, as Access means it: the day
 * is the whole part (negative) and the time the fraction, counted forward
 * (-1.25 is 1899-12-29 06:00). mdb-reader reads the number as one value.
 */
function accessDate(d: Date): Date {
  const days = d.getTime() / DAY_MS + ACCESS_EPOCH_DAYS;
  if (days >= 0 || Number.isInteger(days)) return d;
  const whole = Math.trunc(days);
  return new Date(Math.round((whole + (whole - days) - ACCESS_EPOCH_DAYS) * DAY_MS));
}

/** One value of mdb-reader as a cell of its column. */
export function cellOf(v: unknown, col: Pick<Read, 'type' | 'decimal'>): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : accessDate(v).toISOString();
  }
  if (typeof v === 'bigint') return v.toString();
  if (col.decimal) return String(v);
  if (col.type === 'number') {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'boolean') return v;
  return String(v);
}

/** The significant digits of a decimal text ("-0012.3400" has 3). */
function digitsOf(s: string): number {
  return s.replace(/^[-+]/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length;
}

/** RFC 4180 quoting for one field of the text. */
function csvField(c: Cell): string {
  const s = c === null ? '' : typeof c === 'boolean' ? (c ? 'TRUE' : 'FALSE') : String(c);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The types the values decide, once a table's rows are read: a date and
 * time column whose every value is at midnight is a date; a Currency or
 * Decimal column is a number when a double holds every value exactly (at
 * most {@link EXACT_DIGITS} digits), else text, so no digit is lost.
 */
function settleTypes(cols: readonly Read[], columns: ParsedColumn[], rows: Cell[][]): void {
  columns.forEach((col, i) => {
    if (cols[i]!.decimal) {
      const exact = rows.every((r) => typeof r[i] !== 'string' || digitsOf(r[i]) <= EXACT_DIGITS);
      if (!exact) {
        col.type = 'text';
        return;
      }
      for (const r of rows) if (typeof r[i] === 'string') r[i] = Number(r[i]);
      return;
    }
    if (col.type !== 'datetime') return;
    const midnight = rows.every((r) => typeof r[i] !== 'string' || r[i].endsWith('T00:00:00.000Z'));
    if (!midnight) return;
    col.type = 'date';
    for (const r of rows) if (typeof r[i] === 'string') r[i] = r[i].slice(0, 10);
  });
}

/** Names for a list: the first `max` and a count of the rest. */
function listOf(names: readonly string[], max = Infinity): string {
  const head = names.slice(0, max).join(', ');
  return names.length > max ? `${head} and ${names.length - max} more` : head;
}

/** Whether an error of mdb-reader's open is its refusal of an encrypted
 *  file: a wrong (or no) password, or an encryption it does not read. */
function isPasswordError(err: unknown): boolean {
  return err instanceof Error && /password|encrypt|not implemented/i.test(err.message);
}

/** One table of the file, as the read goes. */
type TableRead = {
  name: string;
  table: ReturnType<MDBReader['getTable']> | null;
  all: AccessColumn[];
  rowCount: number;
  read: Read[];
  skipped: string[];
  /** Rows the read got from the file, and rows it could not read. */
  seen: number;
  bad: number;
  /** Read to its end (not stopped by the keeper or the time). */
  done: boolean;
};

/** The tables of the file with their columns. A table whose definition
 *  cannot be read (a damaged file) has no table and no columns. */
function tablesOf(db: MDBReader): TableRead[] {
  return db.getTableNames().map((name) => {
    const t: TableRead = {
      name,
      table: null,
      all: [],
      rowCount: 0,
      read: [],
      skipped: [],
      seen: 0,
      bad: 0,
      done: false,
    };
    try {
      const table = db.getTable(name);
      t.all = table.getColumns() as AccessColumn[];
      t.rowCount = table.rowCount;
      t.table = table;
    } catch {
      t.all = [];
    }
    for (const c of t.all) {
      const type = columnTypeOf(c);
      if (!type) t.skipped.push(c.name);
      else
        t.read.push({
          name: c.name,
          type,
          ...(c.type === 'currency' || c.type === 'numeric' ? { decimal: true as const } : {}),
        });
    }
    return t;
  });
}

/**
 * Read an Access file. `keep` is the file database's row keeper; `deadline`
 * (ms since the epoch) ends the read with the rows read so far, the cut
 * `database_time` said. A file whose list of tables cannot be read throws.
 */
export function readAccess(
  bytes: Buffer,
  ext: string,
  keep: RowKeeper,
  deadline: number,
): AccessRead {
  let db: MDBReader;
  try {
    db = new MDBReader(bytes);
  } catch (err) {
    if (isPasswordError(err)) return { locked: true };
    throw err;
  }
  // A Jet file's database password does not encrypt its pages, so the
  // reader could read it; a password is the owner's word to keep it shut.
  if (db.getPassword() !== null) return { locked: true };

  const linked = db.getTableNames({ normalTables: false, systemTables: false, linkedTables: true });
  const tables = tablesOf(db);

  const tabs: ParsedSheet[] = [];
  const parts: string[] = [];
  let textChars = 0;
  let textRows = 0;
  let textFull = false;
  let stopped = false;
  let timedOut = false;

  for (const t of tables) {
    const rows: Cell[][] = [];
    const late = () => {
      if (Date.now() <= deadline) return false;
      stopped = timedOut = true;
      return true;
    };
    // Keep one row; false when the keeper stops the read.
    const take = (r: Row) => {
      t.seen += 1;
      const cells = t.read.map((c) => cellOf(r[c.name], c));
      if (!keep.take(cells, t.name)) {
        stopped = true;
        return false;
      }
      rows.push(cells);
      return true;
    };
    if (t.table && t.read.length > 0 && !stopped) {
      const names = t.read.map((c) => c.name);
      const get = (at: number, n: number) =>
        t.table!.getData({ columns: names, rowOffset: at, rowLimit: n }) as Row[];
      for (let at = 0; !stopped; at += BATCH_ROWS) {
        if (late()) break;
        let batch: Row[];
        let bad = 0;
        try {
          batch = get(at, BATCH_ROWS);
        } catch {
          // A damaged page or row: this batch again, one row at a time,
          // inside the table's own row count.
          batch = [];
          for (let i = at; i < Math.min(at + BATCH_ROWS, t.rowCount) && !late(); i += 1) {
            try {
              batch.push(...get(i, 1));
            } catch {
              bad += 1;
            }
          }
        }
        t.bad += bad;
        for (const r of batch) if (!take(r)) break;
        if (stopped) break;
        if (batch.length + bad < BATCH_ROWS) {
          t.done = true;
          break;
        }
      }
    } else if (t.table && t.read.length === 0) {
      t.done = true;
    }
    const columns: ParsedColumn[] = t.read.map((c) => ({ name: c.name, type: c.type }));
    settleTypes(t.read, columns, rows);
    if (columns.length > 0 && rows.length > 0) tabs.push({ name: t.name, columns, rows });

    // The text: the table's head, then its first rows, in the caps.
    if (textFull) continue;
    const head = `## Table: ${t.name} (${Math.max(t.rowCount, t.seen + t.bad)} rows)\nColumns: ${t.all
      .map(
        (c) =>
          `${c.name} (${columnTypeOf(c) ? c.type : `${c.type}${c.calculated ? ', calculated' : ''}, not read`})`,
      )
      .join(', ')}`;
    const lines = [head];
    if (columns.length > 0 && rows.length > 0)
      lines.push(columns.map((c) => csvField(c.name)).join(','));
    let taken = 0;
    let size = lines.join('\n').length;
    for (const r of rows.slice(0, TEXT_ROWS_PER_TABLE)) {
      const line = r.map(csvField).join(',');
      if (textChars + size + line.length + 1 > TEXT_MAX_CHARS) {
        textFull = true;
        break;
      }
      lines.push(line);
      size += line.length + 1;
      taken += 1;
    }
    if (textChars + size > TEXT_MAX_CHARS) {
      textFull = true;
      continue;
    }
    parts.push(lines.join('\n'));
    textChars += size + 2;
    textRows += taken;
  }

  // The rows of the file: a table's count, or the rows the read found when
  // there were more. A table with no column read has no rows to keep.
  const readable = tables.filter((t) => t.table && t.read.length > 0);
  const totalRows = readable.reduce((n, t) => n + Math.max(t.rowCount, t.seen + t.bad), 0);
  // Rows of a table read to its end that could not be read, or that its
  // count has and the read did not find.
  const unread = readable.reduce(
    (n, t) => n + t.bad + (t.done ? Math.max(0, t.rowCount - t.seen - t.bad) : 0),
    0,
  );
  const damaged = readable
    .filter((t) => t.bad > 0 || (t.done && t.rowCount > t.seen + t.bad))
    .map((t) => t.name);
  const noDefinition = tables.filter((t) => !t.table).map((t) => t.name);
  const empty = tables
    .filter((t) => t.table && t.rowCount === 0 && t.seen === 0)
    .map((t) => t.name);
  const skipped = tables.flatMap((t) => t.skipped.map((c) => `${t.name}.${c}`));
  const columnsTotal = tables.reduce((n, t) => n + t.all.length, 0);

  const summary = [
    `# Microsoft Access database (.${ext}): ${tables.length} tables, ${totalRows} rows`,
    ...(linked.length > 0
      ? [`Linked tables (their rows are in another file, not here): ${listOf(linked)}`]
      : []),
    ...(empty.length > 0 ? [`Tables with no rows: ${listOf(empty)}`] : []),
    ...(skipped.length > 0
      ? [
          `Columns not read (attachments, lists of many values, OLE objects, binary, calculated): ${listOf(skipped)}`,
        ]
      : []),
    ...(noDefinition.length > 0
      ? [`Tables that could not be read (the file may be damaged): ${listOf(noDefinition)}`]
      : []),
    ...(damaged.length > 0
      ? [`Tables with rows that could not be read (the file may be damaged): ${listOf(damaged)}`]
      : []),
  ].join('\n');

  const readCuts: Record<string, ReadCutValue> = {};
  const rowCut = keep.cut();
  if (rowCut) {
    // The keeper stopped decoding at its cut: the rows of the file are the
    // counts of its tables.
    for (const [key, value] of Object.entries(rowCut))
      readCuts[key] = { ...value, total: totalRows };
  } else if (timedOut) {
    readCuts.database_time = { what: 'rows', read: keep.kept, total: totalRows };
  }
  if (skipped.length > 0) {
    readCuts.access_columns = {
      what: 'columns',
      read: columnsTotal - skipped.length,
      total: columnsTotal,
    };
  }
  if (noDefinition.length > 0) {
    readCuts.access_tables = {
      what: 'tables',
      read: tables.length - noDefinition.length,
      total: tables.length,
    };
  }
  if (unread > 0) {
    readCuts.access_rows = { what: 'rows', read: totalRows - unread, total: totalRows };
  }
  if (textRows < keep.kept) {
    readCuts.access_text = {
      what: 'rows',
      read: textRows,
      total: keep.kept,
      limit: TEXT_ROWS_PER_TABLE,
    };
  }

  const description =
    `Microsoft Access database: one tab per table of the file, with the table's own name, ` +
    `columns and column types (a Yes/No column is a checkbox; a Date/Time column whose values ` +
    `are all at midnight is a date; a Large Number, and a Currency or Decimal column with a ` +
    `value of more than 15 digits, is text, so no digit is lost). A table with no rows has no tab.` +
    (skipped.length > 0
      ? ` Not read, so not in the tabs: ${listOf(skipped, NAMES_LISTED)} (attachments, lists of many values, OLE objects, binary or calculated).`
      : '') +
    (linked.length > 0
      ? ` Linked tables, whose rows are in another file: ${listOf(linked, NAMES_LISTED)}.`
      : '') +
    (noDefinition.length > 0 || damaged.length > 0
      ? ` Damaged, so read in part or not at all: ${listOf([...noDefinition, ...damaged], NAMES_LISTED)}.`
      : '');

  return {
    locked: false,
    tabs,
    text: [summary, ...parts].join('\n\n'),
    description,
    readCuts,
  };
}

/** The text of a file with a password: what it is and why it was not read. */
export function lockedText(ext: string): string {
  return (
    `Microsoft Access database (.${ext}). It is protected by a password, so its tables were not ` +
    `read. To read it, remove the password in Access and upload the file again.`
  );
}
