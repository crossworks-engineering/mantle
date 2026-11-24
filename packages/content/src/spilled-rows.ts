/**
 * The rows of a long read, from its rows file (the package `sheet` with
 * `request.spill`; the file's lines are in packages/files/src/sheet-spill.ts),
 * a line at a time into the database's write (writeRowsOrWord in
 * ./file-database.ts), so they are never held. One reader for the file:
 * the write takes its tabs in the file's order, each to its end.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { rowFromGrid, type Column, type Row } from '@mantle/content-core/table-model';
import { gridRowOfLine, type GridShape } from '@mantle/files/sheet-to-grid';

/**
 * Row ids in order, in the layout of a UUID of version 7 (the time, then a
 * count, then random bits): the write appends to the id index of a tab of
 * millions of rows instead of putting each id at a random place, which is
 * most of the cost of a long write. Unique: a new time and new random bits
 * every 16,777,216 ids.
 */
export function orderedRowIds(): () => string {
  let time = '';
  let rand = '';
  let n = 0x1000000;
  return () => {
    if (n > 0xffffff) {
      time = Date.now().toString(16).padStart(12, '0').slice(-12);
      rand = randomBytes(6).toString('hex');
      n = 0;
    }
    const c = (n++).toString(16).padStart(6, '0');
    return `${time.slice(0, 8)}-${time.slice(8)}-7${c.slice(0, 3)}-8${c.slice(3)}-${rand}`;
  };
}

export class SpilledRows {
  private readonly nextId = orderedRowIds();
  private readonly lines: AsyncIterator<string>;
  /** A head line read past the end of the tab before it. */
  private head: number | null = null;
  private readonly input: ReturnType<typeof createReadStream>;

  constructor(file: string) {
    this.input = createReadStream(file);
    this.lines = createInterface({ input: this.input, crlfDelay: Infinity })[
      Symbol.asyncIterator
    ]();
  }

  /** The rows of the tab at this index of the write (`tab` of its head
   *  line), typed to `columns`, the table columns made of `shape`: exactly
   *  `expected` of them (the write's count), or a throw. The tabs are asked
   *  in the file's order. */
  async *rowsOf(
    tab: number,
    shape: GridShape,
    columns: readonly Column[],
    expected: number,
  ): AsyncGenerator<Row> {
    let n = 0;
    for await (const row of this.linesOf(tab, shape, columns)) {
      n += 1;
      yield row;
    }
    // The one check of the file: the tab has the rows its write said. A
    // file of another length is a broken read: the throw ends the write
    // before its rename, so no short database takes the name.
    if (n !== expected) {
      throw new Error(`the rows file holds ${n} rows of tab ${tab}, its write said ${expected}`);
    }
  }

  private async *linesOf(
    tab: number,
    shape: GridShape,
    columns: readonly Column[],
  ): AsyncGenerator<Row> {
    while (this.head !== tab) {
      const line = await this.lines.next();
      if (line.done) return;
      const v = parse(line.value);
      if (v !== null && !Array.isArray(v)) this.head = v.tab;
    }
    this.head = null;
    for (;;) {
      const line = await this.lines.next();
      if (line.done) return;
      const v = parse(line.value);
      if (v === null) continue;
      if (!Array.isArray(v)) {
        this.head = v.tab;
        return;
      }
      yield rowFromGrid(columns, gridRowOfLine(shape, v), this.nextId());
    }
  }

  close(): void {
    this.input.destroy();
  }
}

/** One line: a row (an array), a head (`{tab}`), or null for a blank line.
 *  A line that is neither throws: the file is the parser's answer, checked
 *  in length, so a bad line is a broken read, never a row to guess at. */
function parse(line: string): unknown[] | { tab: number } | null {
  if (line === '') return null;
  const v = JSON.parse(line) as unknown;
  if (Array.isArray(v)) return v;
  const tab = (v as { tab?: unknown } | null)?.tab;
  if (typeof tab === 'number') return { tab };
  throw new Error('a line of the spilled rows is neither a row nor a tab head');
}
