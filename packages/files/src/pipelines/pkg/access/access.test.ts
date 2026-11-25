/**
 * The Reader `access` on public test databases (./fixtures/SOURCES.md): an
 * Access 2010 file (`.accdb`) with the common column types, an Access 97
 * file (`.mdb`), a file with attachment and many-value columns, an ACE file
 * encrypted with a password and a Jet file with a database password. No
 * client file.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCutHint, cutMakesPartial } from '../../../read-cut';
import { RowKeeper, fileDbRowKeeper } from '../../../sheet-to-grid';
import type { FileTabsWriteInput, StepJob } from '../../contract';
import { cellOf, columnTypeOf, readAccess } from './access';
import { step } from './step';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const LATER = Date.now() + 60_000;
const read = (name: string, ext = 'accdb', keep = fileDbRowKeeper(), deadline = LATER) =>
  readAccess(fixture(name), ext, keep, deadline);
const open = (name: string, ext = 'accdb', keep?: RowKeeper, deadline?: number) => {
  const r = read(name, ext, keep, deadline);
  if (r.locked) throw new Error('locked');
  return r;
};

describe('an Access 2010 file', () => {
  it('gives one tab per table with rows, with the types of its own columns', () => {
    const r = open('types.accdb');
    expect(r.tabs.map((t) => t.name)).toEqual(['Table1']);
    const [t] = r.tabs;
    expect(t!.columns).toEqual([
      { name: 'A', type: 'text' },
      { name: 'B', type: 'text' },
      { name: 'C', type: 'number' },
      { name: 'D', type: 'number' },
      { name: 'E', type: 'number' },
      { name: 'F', type: 'number' },
      { name: 'G', type: 'date' },
      { name: 'H', type: 'number' },
      { name: 'I', type: 'checkbox' },
    ]);
    expect(t!.rows).toHaveLength(2);
    expect(t!.rows[0]).toEqual(['a', 'b', 0, 0, 0, 0, '1981-12-12', 0, false]);
    expect(t!.rows.every((row) => row.length === t!.columns.length)).toBe(true);
    expect(r.readCuts).toEqual({});
  });

  it('names the tables with no rows, and gives a text of the tables and their rows', () => {
    const r = open('types.accdb');
    expect(r.text).toContain('# Microsoft Access database (.accdb): 4 tables, 2 rows');
    expect(r.text).toContain('Tables with no rows: Table2, Table3, Table4');
    expect(r.text).toContain('## Table: Table1 (2 rows)');
    expect(r.text).toContain('Columns: A (text), B (text), C (byte)');
    expect(r.text).toContain('A,B,C,D,E,F,G,H,I\na,b,0,0,0,0,1981-12-12,0,FALSE');
    expect(r.description).toContain('one tab per table');
    expect(r.description.length).toBeLessThanOrEqual(4000);
  });
});

describe('an Access 97 file', () => {
  it('reads as the 2010 file does', () => {
    const r = open('jet3.mdb', 'mdb');
    expect(r.tabs.map((t) => [t.name, t.rows.length])).toEqual([['Table1', 2]]);
    expect(r.tabs[0]!.rows[0]).toEqual(['a', 'b', 0, 0, 0, 0, '1981-12-12', 0, false]);
    expect(r.text).toContain('# Microsoft Access database (.mdb)');
  });
});

describe('columns with no value to keep in a cell', () => {
  it('reads the other columns, names those, and says the cut', () => {
    const r = open('complex.accdb');
    expect(r.tabs.map((t) => t.name)).toEqual(['Table1']);
    expect(r.tabs[0]!.columns.map((c) => c.name)).toEqual(['id', 'memo-data', 'append-memo-data']);
    expect(r.tabs[0]!.rows.length).toBeGreaterThan(0);
    expect(r.readCuts.access_columns).toEqual({ what: 'columns', read: 3, total: 6 });
    expect(r.description).toContain('Table1.attach-data');
    expect(r.text).toContain('attach-data (complex, not read)');
    expect(cutMakesPartial('access_columns')).toBe(true);
    expect(readCutHint('access_columns', r.readCuts.access_columns!)).toContain('3 of 6 columns');
  });
});

describe('a file with a password', () => {
  it('reads no table of an ACE file encrypted with one', () => {
    expect(read('encrypted.accdb')).toEqual({ locked: true });
  });

  it('reads no table of a Jet file with a database password', () => {
    expect(read('password.mdb', 'mdb')).toEqual({ locked: true });
  });
});

describe('a long read', () => {
  it('keeps the head of the rows at the keeper and says the cut over every row', () => {
    const r = open('types.accdb', 'accdb', new RowKeeper(1, 1024 * 1024));
    expect(r.tabs[0]!.rows).toHaveLength(1);
    expect(r.readCuts.database_rows).toMatchObject({ what: 'rows', read: 1, total: 2, limit: 1 });
  });

  it('stops at the deadline with the rows read, said as the cut database_time', () => {
    const r = open('types.accdb', 'accdb', fileDbRowKeeper(), Date.now() - 1);
    expect(r.tabs).toEqual([]);
    expect(r.readCuts.database_time).toEqual({ what: 'rows', read: 0, total: 2 });
    expect(r.readCuts.access_text).toMatchObject({ read: 0, total: 2 });
  });
});

describe('types and cells', () => {
  it('keeps a number type only where a double holds every value', () => {
    expect(columnTypeOf({ name: 'x', type: 'currency' })).toBe('number');
    expect(columnTypeOf({ name: 'x', type: 'numeric', precision: 15 })).toBe('number');
    expect(columnTypeOf({ name: 'x', type: 'numeric', precision: 18 })).toBe('text');
    expect(columnTypeOf({ name: 'x', type: 'bigint' })).toBe('text');
    expect(columnTypeOf({ name: 'x', type: 'ole' })).toBeNull();
    expect(columnTypeOf({ name: 'x', type: 'binary' })).toBeNull();
    expect(columnTypeOf({ name: 'x', type: 'complex' })).toBeNull();
  });

  it('makes each value a cell of its type', () => {
    expect(cellOf('12.3400', 'number')).toBe(12.34);
    expect(cellOf(9007199254740993n, 'text')).toBe('9007199254740993');
    expect(cellOf(new Date('2026-11-25T10:20:30Z'), 'datetime')).toBe('2026-11-25T10:20:30.000Z');
    expect(cellOf(new Date(Number.NaN), 'datetime')).toBeNull();
    expect(cellOf(Number.POSITIVE_INFINITY, 'number')).toBeNull();
    expect(cellOf(null, 'text')).toBeNull();
  });
});

describe('the step', () => {
  const jobOf = (bytes: Buffer) =>
    ({ bytes: async () => bytes, deadline: Date.now() + 60_000 }) as unknown as StepJob;
  const run = async (name: string, ext: string) => {
    const bytes = fixture(name);
    const r = await step(
      {
        api: 1,
        step: 1,
        options: {},
        file: { name: `x.${ext}`, ext, size: bytes.length, sha256: '0'.repeat(64) },
      },
      jobOf(bytes),
    );
    expect(r.status).toBe('ok');
    return (r.calls?.[0] as { input: FileTabsWriteInput }).input;
  };

  it('writes the tabs, the description and the text', async () => {
    const input = await run('types.accdb', 'accdb');
    expect(input.tabs.map((t) => t.name)).toEqual(['Table1']);
    expect(input.description).toContain('Microsoft Access database');
    expect(input.text).toContain('## Table: Table1');
    expect(input.readCuts).toBeUndefined();
  });

  it('writes no tab for a file with a password, a text that says why, and the cut', async () => {
    const input = await run('encrypted.accdb', 'accdb');
    expect(input.tabs).toEqual([]);
    expect(input.text).toContain('protected by a password');
    expect(input.readCuts).toEqual({ access_password: { what: 'tables', read: 0 } });
    expect(cutMakesPartial('access_password')).toBe(true);
    expect(readCutHint('access_password', input.readCuts!.access_password!)).toContain(
      'Remove the password',
    );
  });

  it('fails on bytes that are no Access file', async () => {
    await expect(
      step(
        {
          api: 1,
          step: 1,
          options: {},
          file: { name: 'x.accdb', ext: 'accdb', size: 9, sha256: '0'.repeat(64) },
        },
        jobOf(Buffer.from('not a db!')),
      ),
    ).rejects.toThrow();
  });
});
