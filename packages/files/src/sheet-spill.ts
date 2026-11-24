/**
 * The rows of a file database read, written to a file as they come (the
 * package `sheet`, a read with `request.spill`). A long CSV or workbook is
 * never held whole in the parser's memory, nor in its answer: each kept
 * body row is one line of the rows file, and the brain reads the file a
 * line at a time into the database (packages/content/src/file-database.ts).
 *
 * The file, JSON Lines, UTF-8: for each tab, a head line `{"tab":<n>}` (its
 * index in the write's `tabs`), then one JSON array for each body row, the
 * raw cells as read (a Date as its ISO text, gridRowOfLine types it back; a
 * NaN or an infinity as its text, which types the same).
 *
 * Three limits, each a real bound, and the cut said on the file
 * (./read-cut.ts, docs/files.md "Read in part"), never a refusal:
 *  - `maxRows`: the import ceiling (TABLE_IMPORT_MAX_ROWS), `database_rows`.
 *  - `maxBytes`: the room the job's scratch space has for the file (a tmpfs
 *    in the parser: memory), `database_size`.
 *  - `until`: the step's deadline, `database_time`: a slow box keeps the
 *    rows it read in time, rather than losing the job.
 * Past any of them every later row is counted, not kept, so the kept rows
 * are the head of the file.
 */
import { closeSync, openSync, statfsSync, writeSync } from 'node:fs';
import path from 'node:path';
import { envNum } from '@mantle/config';
import { PIPELINE_ROWS_FILE } from './pipelines/contract';
import type { RowCut } from './sheet-to-grid';

/** A tab whose rows are in the rows file: its index in the write's `tabs`,
 *  the rows written, and the place of each of its columns in the raw rows. */
export type SpilledTab = { tab: number; rows: number; keep: number[] };

/** Lines are written in blocks of about this many bytes. */
const BLOCK_BYTES = 1024 * 1024;

/** Room left in the scratch space for what else the job writes (its
 *  answer's JSON, the runtime's own files). */
const SCRATCH_RESERVE_BYTES = 64 * 1024 * 1024;

/** The bytes the rows file may take in the folder `dir`: the free space of
 *  its file system, less a reserve. */
export function spillRoomOf(dir: string): number {
  const fs = statfsSync(dir);
  return Math.max(0, Number(fs.bavail) * Number(fs.bsize) - SCRATCH_RESERVE_BYTES);
}

/** The rows file of a file database read in the job's folder `dir`: the
 *  import ceiling of this box, the room of the scratch space, and `until`,
 *  the step's deadline less its write. */
export function fileDbRowsSpill(dir: string, until: number): RowsSpill {
  return new RowsSpill(
    path.join(dir, PIPELINE_ROWS_FILE),
    envNum('TABLE_IMPORT_MAX_ROWS'),
    spillRoomOf(dir),
    until,
  );
}

/** A number JSON has no form for (NaN, an infinity). */
const notFinite = (v: unknown): boolean => typeof v === 'number' && !Number.isFinite(v);

/** Such a number as its text, as the read in memory types it: the text in a
 *  text column, a blank in a number column (normalize), where JSON would
 *  give null and lose the text. */
const finiteOrText = (v: unknown): unknown => (notFinite(v) ? String(v) : v);

export class RowsSpill {
  /** Body rows kept (written). */
  kept = 0;
  /** Body rows seen, kept or not. */
  total = 0;
  /** Set by a reader that stops at the cut (a workbook stream): `total` is
   *  then the rows seen, at least. */
  atLeast = false;
  /** Bytes written. */
  bytes = 0;
  private stopped: 'rows' | 'bytes' | 'time' | null = null;
  private readonly fd: number;
  private block: string[] = [];
  private blockBytes = 0;

  constructor(
    file: string,
    readonly maxRows: number,
    readonly maxBytes: number,
    readonly until: number,
  ) {
    this.fd = openSync(file, 'w');
  }

  /** Whether the cut is reached: every later row is counted only. */
  get full(): boolean {
    return this.stopped !== null;
  }

  /** The rows of the tab at this index of the write's `tabs` follow. */
  startTab(tab: number): void {
    this.put(`{"tab":${tab}}\n`);
  }

  /** Keep this raw body row (true), or count it (false: the cut). */
  take(cells: readonly unknown[]): boolean {
    this.total += 1;
    if (this.stopped) return false;
    if (this.kept >= this.maxRows) this.stopped = 'rows';
    else if (Date.now() > this.until) this.stopped = 'time';
    if (this.stopped) return false;
    const line = `${JSON.stringify(cells.some(notFinite) ? cells.map(finiteOrText) : cells)}\n`;
    const size = Buffer.byteLength(line);
    if (this.bytes + size > this.maxBytes) {
      this.stopped = 'bytes';
      return false;
    }
    this.put(line, size);
    this.kept += 1;
    return true;
  }

  /** Write what is left and close the file. */
  close(): void {
    this.flush();
    closeSync(this.fd);
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
    if (this.stopped === 'rows') return { database_rows: { ...value, limit: this.maxRows } };
    if (this.stopped === 'bytes') return { database_size: { ...value, limit: this.maxBytes } };
    return { database_time: value };
  }

  private put(line: string, size = Buffer.byteLength(line)): void {
    this.block.push(line);
    this.blockBytes += size;
    this.bytes += size;
    if (this.blockBytes >= BLOCK_BYTES) this.flush();
  }

  private flush(): void {
    if (this.block.length === 0) return;
    writeSync(this.fd, this.block.join(''));
    this.block = [];
    this.blockBytes = 0;
  }
}
