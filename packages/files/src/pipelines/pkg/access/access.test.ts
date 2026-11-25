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

describe('calculated columns (Access 2010)', () => {
  it('are not read, named as calculated, and the stored columns are', () => {
    const r = open('calculated.accdb');
    const [t] = r.tabs;
    const names = t!.columns.map((c) => c.name);
    expect(names).toContain('FirstName');
    expect(names).not.toContain('LastFirst');
    expect(names).not.toContain('AllNames');
    expect(r.text).toContain('LastFirst (text, calculated, not read)');
    expect(r.readCuts.access_columns).toMatchObject({ what: 'columns' });
    // No cell holds the junk of a wrapped value.
    for (const row of t!.rows)
      for (const v of row)
        if (typeof v === 'string') expect(v.includes(String.fromCharCode(0))).toBe(false);
    // A Currency column whose values fit a double is a number.
    expect(t!.columns.find((c) => c.name === 'Salary')!.type).toBe('number');
    expect(t!.rows[0]![names.indexOf('Salary')]).toBe(1000000);
    // A Decimal column with a value of 18 digits is text, every digit kept.
    expect(t!.columns.find((c) => c.name === 'Popularity')!.type).toBe('text');
    expect(t!.rows.map((row) => row[names.indexOf('Popularity')])).toContain('102030405060.654321');
  });
});

describe('a damaged file', () => {
  /** types.accdb with one page's type byte broken. Page 76 is the data
   *  page of Table1; page 17 holds the list of the tables. */
  const damaged = (page: number) => {
    const bytes = Buffer.from(fixture('types.accdb'));
    bytes[page * 4096] = 7;
    return bytes;
  };

  it('reads the batch again one row at a time, counts the rows it cannot read, and reads on', () => {
    const r = readAccess(damaged(76), 'accdb', fileDbRowKeeper(), LATER);
    if (r.locked) throw new Error('locked');
    expect(r.tabs).toEqual([]);
    expect(r.readCuts.access_rows).toEqual({ what: 'rows', read: 0, total: 2 });
    expect(r.readCuts.access_tables).toBeUndefined();
    expect(r.text).toContain(
      'Tables with rows that could not be read (the file may be damaged): Table1',
    );
    expect(r.description).toContain('Damaged, so read in part or not at all: Table1');
    expect(cutMakesPartial('access_rows')).toBe(true);
    expect(readCutHint('access_rows', r.readCuts.access_rows!)).toContain('0 of 2 rows');
    expect(cutMakesPartial('access_tables')).toBe(true);
    expect(readCutHint('access_tables', { what: 'tables', read: 3, total: 4 })).toContain(
      '3 of 4 tables',
    );
  });

  it('throws when the list of its tables cannot be read', () => {
    expect(() => readAccess(damaged(17), 'accdb', fileDbRowKeeper(), LATER)).toThrow();
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
    // The text holds every row the database keeps: no text cut.
    expect(r.readCuts.access_text).toBeUndefined();
  });
});

describe('types and cells', () => {
  it('maps the Access types, and reads no file, list or calculated column', () => {
    expect(columnTypeOf({ name: 'x', type: 'currency' })).toBe('number');
    expect(columnTypeOf({ name: 'x', type: 'numeric' })).toBe('number');
    expect(columnTypeOf({ name: 'x', type: 'bigint' })).toBe('text');
    expect(columnTypeOf({ name: 'x', type: 'double', calculated: true })).toBeNull();
    expect(columnTypeOf({ name: 'x', type: 'ole' })).toBeNull();
    expect(columnTypeOf({ name: 'x', type: 'binary' })).toBeNull();
    expect(columnTypeOf({ name: 'x', type: 'complex' })).toBeNull();
  });

  it('makes each value a cell of its type', () => {
    const num = { type: 'number' as const };
    const text = { type: 'text' as const };
    const when = { type: 'datetime' as const };
    expect(cellOf('12.3400', num)).toBe(12.34);
    // A Currency or Decimal value stays text until the read settles its type.
    expect(cellOf('1234567890123.4567', { ...num, decimal: true })).toBe('1234567890123.4567');
    expect(cellOf(9007199254740993n, text)).toBe('9007199254740993');
    expect(cellOf(new Date('2026-11-25T10:20:30Z'), when)).toBe('2026-11-25T10:20:30.000Z');
    expect(cellOf(new Date(Number.NaN), when)).toBeNull();
    expect(cellOf(Number.POSITIVE_INFINITY, num)).toBeNull();
    expect(cellOf(null, text)).toBeNull();
  });

  it('reads a date before 1899-12-30 with a time of day as Access means it', () => {
    // Access -1.25: the day before day 0, at 06:00. mdb-reader gives the
    // number read as one value: day 0 less 1.25 days.
    const naive = new Date(Date.UTC(1899, 11, 30) - 1.25 * 86_400_000);
    expect(cellOf(naive, { type: 'datetime' })).toBe('1899-12-29T06:00:00.000Z');
    const whole = new Date(Date.UTC(1899, 11, 28));
    expect(cellOf(whole, { type: 'datetime' })).toBe('1899-12-28T00:00:00.000Z');
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
