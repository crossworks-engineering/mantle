import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseSheetToGrid, parseTextToGrid } from './sheet-to-grid';

/** Build an .xlsx buffer from an array-of-arrays per sheet. */
function workbook(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true }) as Buffer;
}

describe('parseSheetToGrid', () => {
  it('infers column types from values', () => {
    const buf = workbook({
      Items: [
        ['Item', 'Qty', 'Price', 'InStock', 'Added'],
        ['Widget', 2, 9.5, true, new Date('2026-01-15')],
        ['Gadget', 3, 4, false, new Date('2026-02-20')],
      ],
    });
    const [sheet] = parseSheetToGrid(buf);
    expect(sheet!.name).toBe('Items');
    expect(sheet!.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      'Item:text',
      'Qty:number',
      'Price:number',
      'InStock:checkbox',
      'Added:date',
    ]);
    expect(sheet!.rows[0]).toEqual(['Widget', 2, 9.5, true, '2026-01-15']);
  });

  it('paginates a sheet over the ceiling into parts (no rows lost)', () => {
    const cap = Number(process.env.MANTLE_MAX_GRID_ROWS) || 10000;
    const n = cap + 5;
    const aoa: unknown[][] = [['Name', 'Value']];
    for (let i = 0; i < n; i++) aoa.push([`row-${i}`, i]);
    const parts = parseSheetToGrid(workbook({ Big: aoa }));
    expect(parts.length).toBe(2);
    expect(parts.map((p) => p.rows.length)).toEqual([cap, 5]);
    expect(parts.map((p) => p.part)).toEqual([1, 2]);
    expect(parts.every((p) => p.partsTotal === 2)).toBe(true);
    // identical columns across parts; no rows lost; contiguous slices
    expect(parts[1]!.columns).toEqual(parts[0]!.columns);
    expect(parts.reduce((sum, p) => sum + p.rows.length, 0)).toBe(n);
    expect(parts[1]!.rows[0]).toEqual([`row-${cap}`, cap]);
  });

  it('emits a single un-parted grid for a sheet under the ceiling', () => {
    const parts = parseSheetToGrid(workbook({ Small: [['A'], [1], [2]] }));
    expect(parts.length).toBe(1);
    expect(parts[0]!.part).toBeUndefined();
    expect(parts[0]!.partsTotal).toBeUndefined();
  });

  it('returns one ParsedSheet per non-empty sheet', () => {
    const buf = workbook({
      Income: [['Source', 'Amount'], ['Salary', 1000]],
      Empty: [[]],
      Expenses: [['Item', 'Cost'], ['Rent', 500]],
    });
    const sheets = parseSheetToGrid(buf);
    expect(sheets.map((s) => s.name)).toEqual(['Income', 'Expenses']);
  });

  it('fills blank headers and pads short rows', () => {
    const buf = workbook({
      S: [
        ['A', '', 'C'],
        ['x', 'y'],
      ],
    });
    const [sheet] = parseSheetToGrid(buf);
    expect(sheet!.columns.map((c) => c.name)).toEqual(['A', 'Column 2', 'C']);
    expect(sheet!.rows[0]).toEqual(['x', 'y', null]);
  });

  it('drops phantom all-empty columns from a stray far cell', () => {
    // A real 2-column grid, but one body row has a lone value parked far out
    // (a formatted/merged stray cell), widening the sheet. The empty columns
    // between must be dropped, not imported as `Column 3..N`.
    const wide: unknown[][] = [
      ['Name', 'Qty'],
      ['Widget', 2],
      ['Gadget', 3],
    ];
    const strayRow: unknown[] = [];
    strayRow[10] = 'x'; // stray value at column 11 → width balloons to 11
    wide.push(strayRow);
    const [sheet] = parseSheetToGrid(workbook({ S: wide }));
    // Column 11 carries the stray value so it survives; the 8 empty columns
    // (3..10) between are dropped.
    expect(sheet!.columns.map((c) => c.name)).toEqual(['Name', 'Qty', 'Column 11']);
  });

  it('keeps a real-header column whose body is entirely empty', () => {
    const buf = workbook({
      S: [
        ['Name', 'Notes'],
        ['Ada', null],
        ['Grace', null],
      ],
    });
    const [sheet] = parseSheetToGrid(buf);
    expect(sheet!.columns.map((c) => c.name)).toEqual(['Name', 'Notes']);
    expect(sheet!.rows).toEqual([['Ada', null], ['Grace', null]]);
  });

  it('parses CSV bytes as a single sheet', () => {
    const csv = 'Name,Age\nAda,36\nGrace,40\n';
    const sheets = parseSheetToGrid(Buffer.from(csv, 'utf-8'));
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['Name:text', 'Age:number']);
    expect(sheets[0]!.rows).toEqual([['Ada', 36], ['Grace', 40]]);
  });
});

describe('parseTextToGrid', () => {
  it('parses a markdown pipe table, dropping the separator row', () => {
    const md = `
| Item   | Qty | Price |
|--------|----:|-------|
| Widget | 2   | 9.5   |
| Gadget | 3   | 4     |
`;
    const [sheet] = parseTextToGrid(md);
    expect(sheet!.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['Item:text', 'Qty:number', 'Price:number']);
    expect(sheet!.rows).toEqual([['Widget', 2, 9.5], ['Gadget', 3, 4]]);
  });

  it('parses TSV', () => {
    const [sheet] = parseTextToGrid('Name\tAge\nAda\t36\nGrace\t40');
    expect(sheet!.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['Name:text', 'Age:number']);
    expect(sheet!.rows).toEqual([['Ada', 36], ['Grace', 40]]);
  });

  it('parses CSV (quote-aware)', () => {
    const [sheet] = parseTextToGrid('City,Pop\n"Cape Town, ZA",433688\nOslo,700000');
    expect(sheet!.columns.map((c) => c.name)).toEqual(['City', 'Pop']);
    expect(sheet!.rows[0]).toEqual(['Cape Town, ZA', 433688]);
  });

  it('returns [] for non-tabular / empty text', () => {
    expect(parseTextToGrid('')).toEqual([]);
    expect(parseTextToGrid('just a sentence with no structure')).toHaveLength(1); // single column, still a (degenerate) table
  });
});
