import { describe, expect, it } from 'vitest';
import { withPhantomDimension, workbookBuffer } from './sheet-fixtures.test-helper';
import { parseXlsx } from './xlsx';

describe('parseXlsx', () => {
  it('renders a single sheet as CSV under a header', async () => {
    const buf = await workbookBuffer({
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
    const buf = await workbookBuffer({
      Q1: [['rev'], [100]],
      Q2: [['rev'], [200]],
    });
    const text = await parseXlsx(buf);
    expect(text).toContain('# Sheet: Q1');
    expect(text).toContain('# Sheet: Q2');
    expect(text.indexOf('# Sheet: Q1')).toBeLessThan(text.indexOf('# Sheet: Q2'));
  });

  it('drops fully blank workbooks to empty string (triggers body_too_short upstream)', async () => {
    const buf = await workbookBuffer({ Empty: [] });
    expect((await parseXlsx(buf)).length).toBe(0);
  });

  it('quotes fields carrying a comma, quote or newline', async () => {
    const buf = await workbookBuffer({
      S: [
        ['City', 'Note'],
        ['Cape Town, ZA', 'he said "hi"'],
      ],
    });
    const text = await parseXlsx(buf);
    expect(text).toContain('"Cape Town, ZA","he said ""hi"""');
  });

  it('resolves a formula to its cached value, never the formula text', async () => {
    // exceljs models a formula cell as { formula, result }; the extractor wants
    // the number Excel last computed, exactly as the SheetJS wrapper did.
    const buf = await workbookBuffer({
      S: [
        ['a', 'b', 'total'],
        [2, 3, { formula: 'A2+B2', result: 5 }],
      ],
    });
    const text = await parseXlsx(buf);
    expect(text).toContain('2,3,5');
    expect(text).not.toContain('A2+B2');
  });

  it('renders dates as ISO rather than a locale display format', async () => {
    const buf = await workbookBuffer({
      S: [['when'], [new Date(Date.UTC(2026, 0, 15))]],
    });
    expect(await parseXlsx(buf)).toContain('2026-01-15');
  });

  it('caps a huge-row sheet and flags it truncated', async () => {
    // 6,001 rows: header + 6,000 data rows, against a 5,000-row output cap.
    const rows: unknown[][] = [['marker']];
    for (let i = 1; i <= 6000; i += 1) rows.push([`row_${i}`]);
    rows[1] = ['FIRST_ROW_SENTINEL'];
    rows[6000] = ['LAST_ROW_SENTINEL'];
    const text = await parseXlsx(await workbookBuffer({ Big: rows }));
    expect(text).toContain('FIRST_ROW_SENTINEL');
    expect(text).not.toContain('LAST_ROW_SENTINEL');
    expect(text).toContain('[spreadsheet truncated for indexing');
  });

  it('ignores a phantom used-range instead of walking it', async () => {
    // The regression that drove the whole cap design: a sheet holding two
    // cells but DECLARING a used range of A1:XFD1048576. SheetJS walked the
    // declared range and hung ingest past the 10-minute watchdog; exceljs
    // reads only the cells that exist. So this must be fast AND — unlike the
    // old clamp-and-flag behaviour — must NOT be reported as truncated, since
    // nothing was actually dropped.
    const buf = await withPhantomDimension(await workbookBuffer({ Phantom: [['hello', 'world']] }));
    const started = Date.now();
    const text = await parseXlsx(buf);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(text).toContain('hello,world');
    expect(text).not.toContain('[spreadsheet truncated');
  });

  it('does not flag a small, dense sheet as truncated', async () => {
    const text = await parseXlsx(
      await workbookBuffer({
        Small: [
          ['a', 'b'],
          [1, 2],
        ],
      }),
    );
    expect(text).not.toContain('[spreadsheet truncated');
  });
});
