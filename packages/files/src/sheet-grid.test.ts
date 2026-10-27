import { describe, expect, it } from 'vitest';
import { workbookBuffer } from './sheet-fixtures.test-helper';
import { parseSheetToGrid } from './sheet-grid';

describe('parseSheetToGrid', () => {
  it('infers column types from values', async () => {
    const buf = await workbookBuffer({
      Items: [
        ['Item', 'Qty', 'Price', 'InStock', 'Added'],
        ['Widget', 2, 9.5, true, new Date(Date.UTC(2026, 0, 15))],
        ['Gadget', 3, 4, false, new Date(Date.UTC(2026, 1, 20))],
      ],
    });
    const [sheet] = await parseSheetToGrid(buf);
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

  it('emits big sheets WHOLE — part-splitting is dead (Tables v2)', async () => {
    const n = 10_005; // over the old 10k pagination ceiling
    const aoa: unknown[][] = [['Name', 'Value']];
    for (let i = 0; i < n; i++) aoa.push([`row-${i}`, i]);
    const parts = await parseSheetToGrid(await workbookBuffer({ Big: aoa }));
    expect(parts.length).toBe(1);
    expect(parts[0]!.rows.length).toBe(n);
    expect(parts[0]!.part).toBeUndefined();
    expect(parts[0]!.partsTotal).toBeUndefined();
    expect(parts[0]!.rows[n - 1]).toEqual([`row-${n - 1}`, n - 1]);
  });

  it('emits a single grid for a small sheet', async () => {
    const parts = await parseSheetToGrid(await workbookBuffer({ Small: [['A'], [1], [2]] }));
    expect(parts.length).toBe(1);
    expect(parts[0]!.part).toBeUndefined();
    expect(parts[0]!.partsTotal).toBeUndefined();
  });

  it('returns one ParsedSheet per non-empty sheet', async () => {
    const buf = await workbookBuffer({
      Income: [
        ['Source', 'Amount'],
        ['Salary', 1000],
      ],
      Empty: [[]],
      Expenses: [
        ['Item', 'Cost'],
        ['Rent', 500],
      ],
    });
    const sheets = await parseSheetToGrid(buf);
    expect(sheets.map((s) => s.name)).toEqual(['Income', 'Expenses']);
  });

  it('fills blank headers and pads short rows', async () => {
    const buf = await workbookBuffer({
      S: [
        ['A', null, 'C'],
        ['x', 'y'],
      ],
    });
    const [sheet] = await parseSheetToGrid(buf);
    expect(sheet!.columns.map((c) => c.name)).toEqual(['A', 'Column 2', 'C']);
    expect(sheet!.rows[0]).toEqual(['x', 'y', null]);
  });

  it('drops phantom all-empty columns from a stray far cell', async () => {
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
    const [sheet] = await parseSheetToGrid(await workbookBuffer({ S: wide }));
    // Column 11 carries the stray value so it survives; the 8 empty columns
    // (3..10) between are dropped.
    expect(sheet!.columns.map((c) => c.name)).toEqual(['Name', 'Qty', 'Column 11']);
  });

  it('keeps a real-header column whose body is entirely empty', async () => {
    const buf = await workbookBuffer({
      S: [
        ['Name', 'Notes'],
        ['Ada', null],
        ['Grace', null],
      ],
    });
    const [sheet] = await parseSheetToGrid(buf);
    expect(sheet!.columns.map((c) => c.name)).toEqual(['Name', 'Notes']);
    expect(sheet!.rows).toEqual([
      ['Ada', null],
      ['Grace', null],
    ]);
  });

  it('resolves formula cells to their cached values', async () => {
    const buf = await workbookBuffer({
      S: [
        ['a', 'total'],
        [2, { formula: 'A2*2', result: 4 }],
        [3, { formula: 'A3*2', result: 6 }],
      ],
    });
    const [sheet] = await parseSheetToGrid(buf);
    expect(sheet!.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['a:number', 'total:number']);
    expect(sheet!.rows).toEqual([
      [2, 4],
      [3, 6],
    ]);
  });

  it('parses CSV bytes as a single sheet', async () => {
    const csv = 'Name,Age\nAda,36\nGrace,40\n';
    const sheets = await parseSheetToGrid(Buffer.from(csv, 'utf-8'));
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      'Name:text',
      'Age:number',
    ]);
    expect(sheets[0]!.rows).toEqual([
      ['Ada', 36],
      ['Grace', 40],
    ]);
  });

  it('names a legacy .xls as needing conversion instead of reading it as text', async () => {
    // OLE2 magic. Without this branch the bytes would be decoded as UTF-8 and
    // imported as a grid of mojibake, which looks like a successful import.
    const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    await expect(parseSheetToGrid(ole2)).rejects.toThrow(/legacy \.xls/);
  });
});
