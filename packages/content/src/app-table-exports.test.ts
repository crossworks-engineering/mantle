import { describe, expect, it } from 'vitest';

// The module pulls in the tables surface (drizzle at import time), so the DB
// package is stubbed — these tests exercise only the pure mapping helpers.
import { vi } from 'vitest';
vi.mock('@mantle/db', () => ({
  db: {},
  nodes: {},
  appTableExports: {},
  tables: {},
  notifyNodeIngested: () => undefined,
}));

const { assertTableIdent, columnTypeOf } = await import('./app-table-exports');

/**
 * The export sync derives the brain Table's typed columns from SQLite declared
 * types. Wrong order here mislabels real data (DATETIME contains DATE; SQLite
 * booleans are INTEGER affinity) — pin the precedence.
 */
describe('columnTypeOf', () => {
  it('maps numeric affinities to number', () => {
    expect(columnTypeOf('INTEGER')).toBe('number');
    expect(columnTypeOf('int')).toBe('number');
    expect(columnTypeOf('REAL')).toBe('number');
    expect(columnTypeOf('NUMERIC(10,2)')).toBe('number');
    expect(columnTypeOf('DECIMAL')).toBe('number');
    expect(columnTypeOf('DOUBLE PRECISION')).toBe('number');
  });

  it('prefers BOOLEAN over its INTEGER affinity', () => {
    expect(columnTypeOf('BOOLEAN')).toBe('checkbox');
    expect(columnTypeOf('bool')).toBe('checkbox');
  });

  it('prefers DATETIME/TIMESTAMP over the DATE substring', () => {
    expect(columnTypeOf('DATETIME')).toBe('datetime');
    expect(columnTypeOf('TIMESTAMP')).toBe('datetime');
    expect(columnTypeOf('DATE')).toBe('date');
  });

  it('falls back to text for TEXT, unknown, and absent decltypes', () => {
    expect(columnTypeOf('TEXT')).toBe('text');
    expect(columnTypeOf('VARCHAR(80)')).toBe('text');
    expect(columnTypeOf('')).toBe('text');
    expect(columnTypeOf(null)).toBe('text');
    expect(columnTypeOf(undefined)).toBe('text');
  });
});

/**
 * Table names are interpolated into quoted SQL identifiers — the ident guard
 * is the injection boundary, same contract as the seed path.
 */
describe('assertTableIdent', () => {
  it('accepts plain identifiers', () => {
    expect(() => assertTableIdent('tasks')).not.toThrow();
    expect(() => assertTableIdent('_meta2')).not.toThrow();
  });

  it('rejects quoting, spaces, dots, and sqlite_* internals', () => {
    expect(() => assertTableIdent('tasks"; DROP TABLE x; --')).toThrow(/invalid/i);
    expect(() => assertTableIdent('my table')).toThrow(/invalid/i);
    expect(() => assertTableIdent('a.b')).toThrow(/invalid/i);
    expect(() => assertTableIdent('sqlite_master')).toThrow(/invalid/i);
    expect(() => assertTableIdent('')).toThrow(/invalid/i);
  });
});
