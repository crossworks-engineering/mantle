/**
 * The legacy-sheet conversion (./legacy-sheet.ts) through the real anydoc
 * addon, on binary `.xls` files written from scratch by
 * ./biff.test-helper.ts (no client file, nothing downloaded).
 */
import { describe, expect, it } from 'vitest';
import { biffXls } from './biff.test-helper';
import { convertLegacySheetToXlsx, isLegacySheetExt, MAX_LEGACY_CELLS } from './legacy-sheet';
import { isDocumentTooLarge } from './read-limit';
import { parseSheetToGrid } from './sheet-grid';
import { workbookBuffer } from './sheet-fixtures.test-helper';
import { parseXlsx } from './xlsx';

const ORDERS = biffXls([
  {
    name: 'Orders',
    rows: [
      ['Name', 'Qty', 'Price'],
      ['Widget', 3, 12.5],
      ['Gadget', 10, 4.25],
    ],
  },
  { name: 'Notes', rows: [['Note'], ['second sheet, one column']] },
]);

describe('isLegacySheetExt', () => {
  it('covers only the formats exceljs cannot read', () => {
    expect(isLegacySheetExt('xls')).toBe(true);
    expect(isLegacySheetExt('XLSB')).toBe(true);
    expect(isLegacySheetExt('xlsx')).toBe(false);
    expect(isLegacySheetExt('xlsm')).toBe(false);
    expect(isLegacySheetExt('csv')).toBe(false);
  });
});

describe('convertLegacySheetToXlsx', () => {
  it('produces a workbook the ordinary exceljs reader can parse', async () => {
    const converted = await convertLegacySheetToXlsx(ORDERS);
    expect(converted).not.toBeNull();
    const text = await parseXlsx(converted!.xlsx);
    expect(text).toContain('# Sheet: Orders');
    expect(text).toContain('# Sheet: Notes');
    expect(text).toContain('Widget,3,12.5');
  });

  it('keeps numeric columns numeric through the round trip', async () => {
    const converted = await convertLegacySheetToXlsx(ORDERS);
    const [orders] = await parseSheetToGrid(converted!.xlsx);
    expect(orders!.name).toBe('Orders');
    expect(orders!.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      'Name:text',
      'Qty:number',
      'Price:number',
    ]);
    expect(orders!.rows).toEqual([
      ['Widget', 3, 12.5],
      ['Gadget', 10, 4.25],
    ]);
  });

  it('hands an .xlsx under a legacy name on as it is', async () => {
    const bytes = await workbookBuffer({ Orders: [['Tag'], ['P-101']] });
    expect(await convertLegacySheetToXlsx(bytes)).toEqual({ xlsx: bytes, refused: [] });
  });

  it('returns null for bytes anydoc cannot read', async () => {
    expect(await convertLegacySheetToXlsx(Buffer.from('junk'))).toBeNull();
  });

  it('sanitises a sheet name Excel would reject', async () => {
    const xls = biffXls([{ name: 'Q1/Q2 [draft]: a long tab', rows: [['x']] }]);
    const converted = await convertLegacySheetToXlsx(xls);
    const [sheet] = await parseSheetToGrid(converted!.xlsx);
    expect(sheet!.name).not.toMatch(/[\\/?*[\]:]/);
    expect(sheet!.name.length).toBeLessThanOrEqual(31);
  });

  it('refuses as too large a sheet laid out past the cell budget', async () => {
    // A1 and one cell far down and across: the rendering is the rectangle.
    const rows: (string | number)[][] = [['a']];
    const far = Math.ceil(MAX_LEGACY_CELLS / 200) + 10;
    for (let r = 1; r < far; r++) rows.push([]);
    rows.push(Array.from({ length: 200 }, (_, c) => (c === 199 ? 'b' : '')));
    const xls = biffXls([{ name: 'Sparse', rows }]);
    const err = await convertLegacySheetToXlsx(xls).catch((e: unknown) => e);
    expect(isDocumentTooLarge(err)).toBe(true);
    expect((err as Error).message).toMatch(/Sparse/);
  });
});
