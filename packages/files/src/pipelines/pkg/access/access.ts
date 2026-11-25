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
 *   values, an OLE object, a binary field) are not read: named in the
 *   description and the text, and said as the cut `access_columns` (the
 *   file is partial). mdb-reader reads a complex column (attachments, many
 *   values) as attachments only, and reads its whole hidden table again for
 *   every row; an OLE object can be megabytes a cell.
 * - A file with a password is not read (an ACE file encrypted with one, or
 *   a Jet file with a database password): its text says so, and the cut
 *   `access_password` gives the reason on the file.
 * - The text keeps at most {@link TEXT_ROWS_PER_TABLE} rows a table and
 *   {@link TEXT_MAX_CHARS} characters, the text read's caps of a workbook
 *   (../../../xlsx.ts); the cut `access_text` says how many rows are in it.
 *   Every kept row is in the database for file_sql.
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

/** A column of mdb-reader (its `getColumns()`), the fields this reads. */
type AccessColumn = { name: string; type: string; precision?: number };
type Cell = string | number | boolean | null;
type Read = { name: string; type: InferredColumnType };

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
 * The tab type of an Access column, or null for one with no value to keep in
 * a cell. A number type only where a double holds every value exactly: a
 * Decimal of more than 15 digits and a Large Number (bigint) are text.
 */
export function columnTypeOf(c: AccessColumn): InferredColumnType | null {
  switch (c.type) {
    case 'boolean':
      return 'checkbox';
    case 'byte':
    case 'integer':
    case 'long':
    case 'float':
    case 'double':
    case 'currency':
      return 'number';
    case 'numeric':
      return (c.precision ?? 28) <= 15 ? 'number' : 'text';
    case 'datetime':
      return 'datetime';
    case 'text':
    case 'memo':
    case 'repid':
    case 'bigint':
    case 'datetimextended':
      return 'text';
    default:
      // ole, binary, complex (attachments, many values, version history).
      return null;
  }
}

/** One value of mdb-reader as a cell of its column's type. */
export function cellOf(v: unknown, type: InferredColumnType): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (type === 'number') {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'boolean') return v;
  return String(v);
}

/** RFC 4180 quoting for one field of the text. */
function csvField(c: Cell): string {
  const s = c === null ? '' : typeof c === 'boolean' ? (c ? 'TRUE' : 'FALSE') : String(c);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A date and time column whose every value is at midnight is a date. */
function narrowDates(columns: ParsedColumn[], rows: Cell[][]): void {
  columns.forEach((col, i) => {
    if (col.type !== 'datetime') return;
    const midnight = rows.every((r) => {
      const v = r[i];
      return typeof v !== 'string' || v.endsWith('T00:00:00.000Z');
    });
    if (!midnight) return;
    col.type = 'date';
    for (const r of rows) {
      const v = r[i];
      if (typeof v === 'string') r[i] = v.slice(0, 10);
    }
  });
}

/** Names for a list: the first `max` and a count of the rest. */
function listOf(names: readonly string[], max = Infinity): string {
  const head = names.slice(0, max).join(', ');
  return names.length > max ? `${head} and ${names.length - max} more` : head;
}

/** Whether an error of mdb-reader is its refusal of an encrypted file. */
function isPasswordError(err: unknown): boolean {
  return err instanceof Error && /password/i.test(err.message);
}

/**
 * Read an Access file. `keep` is the file database's row keeper; `deadline`
 * (ms since the epoch) ends the read with the rows read so far, the cut
 * `database_time` said. A file mdb-reader cannot read throws.
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
  const tables = db.getTableNames().map((name) => {
    const table = db.getTable(name);
    const all = table.getColumns() as AccessColumn[];
    const read: Read[] = [];
    const skipped: string[] = [];
    for (const c of all) {
      const type = columnTypeOf(c);
      if (type) read.push({ name: c.name, type });
      else skipped.push(c.name);
    }
    return { name, table, all, read, skipped };
  });
  const totalRows = tables.reduce((n, t) => n + (t.read.length > 0 ? t.table.rowCount : 0), 0);

  const tabs: ParsedSheet[] = [];
  const parts: string[] = [];
  let textChars = 0;
  let textRows = 0;
  let textFull = false;
  let stopped = false;
  let timedOut = false;
  const empty: string[] = [];

  for (const t of tables) {
    const head = `## Table: ${t.name} (${t.table.rowCount} rows)\nColumns: ${t.all
      .map((c) => `${c.name} (${columnTypeOf(c) ? c.type : `${c.type}, not read`})`)
      .join(', ')}`;
    if (t.table.rowCount === 0) empty.push(t.name);
    const rows: Cell[][] = [];
    if (t.read.length > 0 && !stopped) {
      const names = t.read.map((c) => c.name);
      for (let at = 0; at < t.table.rowCount && !stopped; at += BATCH_ROWS) {
        if (Date.now() > deadline) {
          stopped = timedOut = true;
          break;
        }
        const batch = t.table.getData({ columns: names, rowOffset: at, rowLimit: BATCH_ROWS });
        if (batch.length === 0) break;
        for (const r of batch) {
          const cells = t.read.map((c) => cellOf(r[c.name], c.type));
          if (!keep.take(cells, t.name)) {
            stopped = true;
            break;
          }
          rows.push(cells);
        }
      }
    }
    const columns: ParsedColumn[] = t.read.map((c) => ({ name: c.name, type: c.type }));
    narrowDates(columns, rows);
    if (columns.length > 0 && rows.length > 0) tabs.push({ name: t.name, columns, rows });

    // The text: the table's head, then its first rows, in the caps.
    if (textFull) continue;
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
          `Columns not read (attachments, lists of many values, OLE objects, binary): ${listOf(skipped)}`,
        ]
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
  if (textRows < totalRows) {
    readCuts.access_text = {
      what: 'rows',
      read: textRows,
      total: totalRows,
      limit: TEXT_ROWS_PER_TABLE,
    };
  }

  const description =
    `Microsoft Access database: one tab per table of the file, with the table's own name, ` +
    `columns and column types (a Yes/No column is a checkbox; a Date/Time column whose values ` +
    `are all at midnight is a date; a Large Number, and a Decimal of more than 15 digits, is ` +
    `text, so no digit is lost). A table with no rows has no tab.` +
    (skipped.length > 0
      ? ` Not read, so not in the tabs: ${listOf(skipped, NAMES_LISTED)} (attachments, lists of many values, OLE objects or binary).`
      : '') +
    (linked.length > 0
      ? ` Linked tables, whose rows are in another file: ${listOf(linked, NAMES_LISTED)}.`
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
