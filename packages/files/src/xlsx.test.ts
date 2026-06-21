import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseXlsx } from './xlsx';

/** Build an .xlsx buffer in-memory so the round-trip test needs no fixture. */
function makeWorkbook(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('parseXlsx', () => {
  it('renders a single sheet as CSV under a header', async () => {
    const buf = makeWorkbook({
      Invoices: [
        ['Date', 'Amount', 'Paid'],
        ['2026-05-20', 1200, 'yes'],
      ],
    });
    const text = await parseXlsx(buf);
    expect(text).toContain('# Sheet: Invoices');
    expect(text).toContain('Date,Amount,Paid');
    expect(text).toContain('2026-05-20,1200,yes');
  });

  it('separates multiple sheets with their own headers', async () => {
    const buf = makeWorkbook({
      Q1: [['rev'], [100]],
      Q2: [['rev'], [200]],
    });
    const text = await parseXlsx(buf);
    expect(text).toContain('# Sheet: Q1');
    expect(text).toContain('# Sheet: Q2');
    expect(text.indexOf('# Sheet: Q1')).toBeLessThan(text.indexOf('# Sheet: Q2'));
  });

  it('drops fully blank workbooks to empty string (triggers body_too_short upstream)', async () => {
    const buf = makeWorkbook({ Empty: [] });
    expect((await parseXlsx(buf)).length).toBe(0);
  });

  it('caps a huge-row sheet and flags it truncated (no million-row walk)', async () => {
    // 6,001 rows: header + 6,000 data rows. sheetRows caps the read at 5,000,
    // so the tail must be dropped and the result marked truncated.
    const rows: unknown[][] = [['marker']];
    for (let i = 1; i <= 6000; i += 1) rows.push([`row_${i}`]);
    rows[1] = ['FIRST_ROW_SENTINEL'];
    rows[6000] = ['LAST_ROW_SENTINEL'];
    const text = await parseXlsx(makeWorkbook({ Big: rows }));
    expect(text).toContain('FIRST_ROW_SENTINEL');
    expect(text).not.toContain('LAST_ROW_SENTINEL');
    expect(text).toContain('[spreadsheet truncated for indexing');
  });

  it('clamps a phantom-wide used-range instead of walking it', async () => {
    // Real data is one tiny cell, but the sheet declares a used range out to
    // column ZZ (701 cols). The clamp must keep the data + flag truncation,
    // and — critically — return fast (no 700-column iteration explosion).
    const ws = XLSX.utils.aoa_to_sheet([['hello', 'world']]);
    ws['!ref'] = 'A1:ZZ1';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Phantom');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const text = await parseXlsx(buf);
    expect(text).toContain('hello,world');
    expect(text).toContain('[spreadsheet truncated for indexing');
  });

  it('does not flag a small, dense sheet as truncated', async () => {
    const text = await parseXlsx(
      makeWorkbook({ Small: [['a', 'b'], [1, 2]] }),
    );
    expect(text).not.toContain('[spreadsheet truncated');
  });
});
