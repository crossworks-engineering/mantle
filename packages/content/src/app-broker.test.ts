import { describe, expect, it } from 'vitest';
import { assertSafe } from './app-broker';

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
