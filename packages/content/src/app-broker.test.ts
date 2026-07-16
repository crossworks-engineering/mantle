import { describe, expect, it } from 'vitest';
import {
  assertSafe,
  assertSafeScript,
  appDbFiles,
  vacuumIntoStatement,
  snapshotDestPath,
} from './app-broker';

/**
 * `assertSafe` is the runtime guard on SQL a sandboxed mini app sends through
 * the db-broker. It must reject the statements that let SQLite reach beyond its
 * own file (ATTACH/DETACH, PRAGMA, `VACUUM INTO`) and allow ordinary CRUD.
 */
describe('assertSafe', () => {
  it('allows ordinary CRUD statements', () => {
    expect(() => assertSafe('SELECT * FROM cities')).not.toThrow();
    expect(() => assertSafe('INSERT INTO cities (name) VALUES (?)')).not.toThrow();
    expect(() => assertSafe('UPDATE cities SET name = ? WHERE id = ?')).not.toThrow();
    expect(() => assertSafe('DELETE FROM cities WHERE id = ?')).not.toThrow();
    expect(() => assertSafe('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)')).not.toThrow();
  });

  it('blocks ATTACH / DETACH (cross-database file escape)', () => {
    expect(() => assertSafe("ATTACH DATABASE '/etc/passwd' AS x")).toThrow(/not allowed/i);
    expect(() => assertSafe('DETACH DATABASE x')).toThrow(/not allowed/i);
  });

  it('blocks PRAGMA and `VACUUM INTO`', () => {
    expect(() => assertSafe('PRAGMA journal_mode = WAL')).toThrow(/not allowed/i);
    expect(() => assertSafe("VACUUM INTO '/tmp/copy.sqlite'")).toThrow(/not allowed/i);
  });

  it('ignores leading whitespace and is case-insensitive', () => {
    expect(() => assertSafe('   \n\t attach database "x" as y')).toThrow(/not allowed/i);
    expect(() => assertSafe('  PrAgMa foreign_keys = ON')).toThrow(/not allowed/i);
  });

  it('does not flag a plain VACUUM (no INTO target)', () => {
    // `VACUUM` rewrites the app's own file in place — no file escape, so allowed.
    expect(() => assertSafe('VACUUM')).not.toThrow();
  });

  it('does not flag identifiers that merely start with a blocked word', () => {
    // The guard is anchored to the statement verb, so a column/table named
    // `pragmatic` or `attachments` must not trip it.
    expect(() => assertSafe('SELECT * FROM attachments')).not.toThrow();
    expect(() => assertSafe('SELECT pragmatic FROM notes')).not.toThrow();
  });

  it('allows read-only PRAGMA table_info / table_xinfo (schema introspection)', () => {
    // The one PRAGMA exception: generated apps need it for idempotent column
    // migrations. It reads the app's own schema only — no file/engine escape.
    expect(() => assertSafe('PRAGMA table_info(dcl_items)')).not.toThrow();
    expect(() => assertSafe('pragma table_xinfo(cities)')).not.toThrow();
    expect(() => assertSafe('  PRAGMA  TABLE_INFO ( cities ) ; ')).not.toThrow();
    expect(() => assertSafe('PRAGMA table_info("my table")')).not.toThrow();
    expect(() => assertSafe("PRAGMA table_info('cities')")).not.toThrow();
    expect(() => assertSafe('PRAGMA table_info(`cities`)')).not.toThrow();
    expect(() => assertSafe('PRAGMA table_info([cities])')).not.toThrow();
  });

  it('still blocks every other PRAGMA and any piggyback after table_info', () => {
    // The exception is anchored end-to-end — trailing SQL after the closing
    // paren falls through to the blanket PRAGMA block.
    expect(() => assertSafe("PRAGMA table_info(t); ATTACH DATABASE '/etc/passwd' AS x")).toThrow(
      /not allowed/i,
    );
    expect(() => assertSafe('PRAGMA table_info(t) -- comment')).toThrow(/not allowed/i);
    // Assignment form (`= value`) is not introspection — blocked.
    expect(() => assertSafe('PRAGMA table_info = 1')).toThrow(/not allowed/i);
    expect(() => assertSafe('PRAGMA writable_schema = ON')).toThrow(/not allowed/i);
    expect(() => assertSafe('PRAGMA wal_checkpoint(TRUNCATE)')).toThrow(/not allowed/i);
    expect(() => assertSafe('PRAGMA database_list')).toThrow(/not allowed/i);
    expect(() => assertSafe('PRAGMA table_list')).toThrow(/not allowed/i);
  });
});

/**
 * `assertSafeScript` guards multi-statement schema DDL. `assertSafe` alone only
 * inspects the first verb, so the script guard is what stops a piggybacked
 * ATTACH after a legitimate CREATE TABLE.
 */
describe('assertSafeScript', () => {
  it('allows a multi-statement schema of plain DDL', () => {
    const ddl =
      'CREATE TABLE IF NOT EXISTS cities (name TEXT PRIMARY KEY);\n' +
      'CREATE INDEX IF NOT EXISTS cities_name ON cities (name);';
    expect(() => assertSafeScript(ddl)).not.toThrow();
  });

  it('blocks a blocked verb piggybacked after a valid statement', () => {
    const ddl = "CREATE TABLE t (x INTEGER); ATTACH DATABASE '/etc/passwd' AS leak;";
    expect(() => assertSafeScript(ddl)).toThrow(/not allowed/i);
  });

  it('blocks a PRAGMA buried mid-script', () => {
    const ddl = 'CREATE TABLE a (x); PRAGMA writable_schema = ON; CREATE TABLE b (y);';
    expect(() => assertSafeScript(ddl)).toThrow(/not allowed/i);
  });

  it('tolerates trailing semicolons and blank statements', () => {
    expect(() => assertSafeScript('CREATE TABLE t (x);;\n  ;')).not.toThrow();
  });

  it('allows the table_info introspection exception mid-script too', () => {
    expect(() =>
      assertSafeScript('CREATE TABLE t (x); PRAGMA table_info(t); CREATE TABLE u (y);'),
    ).not.toThrow();
  });
});

/**
 * The broker runs queries via `prepare(sql).all()` on node:sqlite — verify the
 * newly-allowed `PRAGMA table_info` actually returns column rows through that
 * exact call shape (a regression here would pass the guard but die at runtime).
 */
describe('PRAGMA table_info through node:sqlite', () => {
  it('returns one row per column via prepare().all()', () => {
    // getBuiltinModule keeps vite/vitest from trying to bundle node:sqlite.
    const { DatabaseSync } = process.getBuiltinModule(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
      const rows = db.prepare('PRAGMA table_info(items)').all() as { name: string }[];
      expect(rows.map((r) => r.name)).toEqual(['id', 'name']);
    } finally {
      db.close();
    }
  });
});

/**
 * On delete we must remove not just the .sqlite file but every sidecar SQLite
 * can leave behind, or the volume leaks files after an app is deleted.
 */
describe('appDbFiles', () => {
  it('lists the db file plus its journal/WAL/SHM sidecars', () => {
    const base = '/data/app-dbs/owner/app.sqlite';
    expect(appDbFiles(base)).toEqual([base, `${base}-journal`, `${base}-wal`, `${base}-shm`]);
  });
});

/**
 * The backup snapshots each app DB with `VACUUM INTO '<dest>'`. The dest path is
 * server-derived, but the statement builder must still single-quote-escape it so
 * a path containing a quote can't break the SQL literal.
 */
describe('vacuumIntoStatement', () => {
  it('wraps the destination in a single-quoted literal', () => {
    expect(vacuumIntoStatement('/backups/o/a.sqlite')).toBe("VACUUM INTO '/backups/o/a.sqlite'");
  });

  it("doubles embedded single quotes so the literal can't be broken out of", () => {
    expect(vacuumIntoStatement("/b/a'; DROP TABLE t;--.sqlite")).toBe(
      "VACUUM INTO '/b/a''; DROP TABLE t;--.sqlite'",
    );
  });
});

describe('snapshotDestPath', () => {
  it('mirrors the live <owner>/<app>.sqlite layout under destDir', () => {
    expect(snapshotDestPath('/tmp/snap', 'owner-1', 'app-9')).toBe(
      '/tmp/snap/owner-1/app-9.sqlite',
    );
  });
});
