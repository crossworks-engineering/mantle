import { existsSync } from 'node:fs';

/**
 * Thin node:sqlite access layer. Structural types keep us compatible across
 * @types/node versions; process.getBuiltinModule keeps bundlers out of it
 * (app-broker convention).
 *
 * Handle discipline (plan §3.2): per-request open/close, no long-lived
 * handles — that is also what makes the commit-time atomic rename safe under
 * the registry lock.
 */

export type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Record<string, unknown>[];
  };
  close(): void;
};
type SqliteCtor = new (file: string, opts?: { readOnly?: boolean }) => SqliteDb;

function ctor(): SqliteCtor {
  const mod = process.getBuiltinModule('node:sqlite') as unknown as { DatabaseSync: SqliteCtor };
  return mod.DatabaseSync;
}

/** Registry says a file should exist but it doesn't — the one error class we
 *  NEVER self-heal (deliberate inversion of app-broker): a silently recreated
 *  empty workbook looks exactly like data loss. Surfaced to the caller and the
 *  sanity check. */
export class TableFileMissingError extends Error {
  constructor(public readonly file: string) {
    super(
      `table storage file missing: ${file} — the registry references a workbook that is not on disk. ` +
        `Restore it from backups (VACUUM INTO snapshots ship beside pg_dump) or check the table-dbs mount; ` +
        `Mantle will not recreate it empty.`,
    );
    this.name = 'TableFileMissingError';
  }
}

export type OpenOptions = {
  readOnly?: boolean;
  /** Default TRUE: reads/edits must never create. Only create/import/migration
   *  pass false (and they build into a temp path + rename anyway). */
  mustExist?: boolean;
};

export function openTableFile(file: string, opts: OpenOptions = {}): SqliteDb {
  const { readOnly = false, mustExist = true } = opts;
  if (mustExist && !existsSync(file)) throw new TableFileMissingError(file);
  const Db = ctor();
  // node:sqlite rejects an explicit `undefined` options argument.
  const db = readOnly ? new Db(file, { readOnly: true }) : new Db(file);
  if (readOnly) {
    db.exec('PRAGMA busy_timeout = 5000');
  } else {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
  }
  return db;
}

/** Escape a value for embedding in single quotes (VACUUM INTO's path — the
 *  one statement that can't take a bind parameter). */
export function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
