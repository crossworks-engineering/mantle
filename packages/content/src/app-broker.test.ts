import { describe, expect, it } from 'vitest';
import { assertSafe, assertSafeScript, appDbFiles } from './app-broker';

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
});

/**
 * On delete we must remove not just the .sqlite file but every sidecar SQLite
 * can leave behind, or the volume leaks files after an app is deleted.
 */
describe('appDbFiles', () => {
  it('lists the db file plus its journal/WAL/SHM sidecars', () => {
    const base = '/data/app-dbs/owner/app.sqlite';
    expect(appDbFiles(base)).toEqual([
      base,
      `${base}-journal`,
      `${base}-wal`,
      `${base}-shm`,
    ]);
  });
});
