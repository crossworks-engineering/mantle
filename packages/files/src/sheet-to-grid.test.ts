import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseSheetToGrid } from './sheet-to-grid';

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

  it('parses CSV bytes as a single sheet', () => {
    const csv = 'Name,Age\nAda,36\nGrace,40\n';
    const sheets = parseSheetToGrid(Buffer.from(csv, 'utf-8'));
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['Name:text', 'Age:number']);
    expect(sheets[0]!.rows).toEqual([['Ada', 36], ['Grace', 40]]);
  });
});
