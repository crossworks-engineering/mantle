/**
 * `buildSheet` — the writer behind the `sheet_build` agent tool. The bytes are
 * re-opened with exceljs and inspected, so every assertion is about what a
 * reader actually gets rather than about what we intended to write.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildSheet, SheetSpecError, type WorkbookSpec } from './build-sheet';

async function reopen(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

function fillOf(cell: ExcelJS.Cell): string | undefined {
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  return fill?.type === 'pattern' ? (fill.fgColor?.argb ?? undefined) : undefined;
}

const INVOICES: WorkbookSpec = {
  sheets: [
    {
      name: 'Invoices',
      title: 'Q1 2026 invoices',
      columns: [
        { key: 'ref', header: 'Ref', type: 'text' },
        { key: 'amount', header: 'Amount', type: 'currency', format: { currency: 'ZAR' } },
        { key: 'margin', header: 'Margin', type: 'percent' },
        { key: 'issued', header: 'Issued', type: 'date' },
        { key: 'paid', header: 'Paid', type: 'boolean' },
        { key: 'portal', header: 'Portal', type: 'url' },
      ],
      rows: [
        {
          ref: 'INV-1',
          amount: 12500,
          margin: 34,
          issued: '2026-01-15',
          paid: true,
          portal: 'https://example.com/1',
        },
        {
          ref: 'INV-2',
          amount: 4820.5,
          margin: 21,
          issued: '2026-02-01',
          paid: false,
          portal: 'nope',
        },
      ],
      totals: { amount: 'sum' },
    },
  ],
};

describe('buildSheet — content', () => {
  it('writes typed cells a reader can actually compute with', async () => {
    const ws = (await reopen(await buildSheet(INVOICES))).worksheets[0]!;
    // Title block, then a spacer, then the header on row 3.
    expect(ws.getCell(1, 1).value).toBe('Q1 2026 invoices');
    expect(ws.getRow(3).getCell(1).value).toBe('Ref');
    const first = ws.getRow(4);
    expect(first.getCell(1).value).toBe('INV-1');
    expect(first.getCell(2).value).toBe(12500); // a number, not "R 12,500.00"
    expect(String(first.getCell(2).numFmt)).toContain('ZAR');
    expect(first.getCell(4).value).toBeInstanceOf(Date);
    expect(first.getCell(5).value).toBe(true);
    expect(first.getCell(6).value).toMatchObject({ hyperlink: 'https://example.com/1' });
    // Not navigable → stays plain text rather than a broken link.
    expect(ws.getRow(5).getCell(6).value).toBe('nope');
  });

  it('totals the column it was asked to, and labels the row', async () => {
    const ws = (await reopen(await buildSheet(INVOICES))).worksheets[0]!;
    const last = ws.lastRow!;
    expect(last.getCell(1).value).toBe('Totals');
    expect(last.getCell(2).value).toBe(17320.5);
  });

  it('accepts a number the agent quoted out of a document', async () => {
    // "R 1 234.50" is what an agent copying from an invoice produces. Rejecting
    // it would push the value into a text cell, where it silently stops being
    // addable — the exact failure the currency type exists to prevent.
    const ws = (
      await reopen(
        await buildSheet({
          sheets: [
            {
              name: 'S',
              columns: [{ key: 'amt', header: 'Amt', type: 'currency' }],
              rows: [{ amt: 'R 1 234.50' }, { amt: '2,000' }],
              totals: { amt: 'sum' },
            },
          ],
        }),
      )
    ).worksheets[0]!;
    expect(ws.getRow(2).getCell(1).value).toBe(1234.5);
    expect(ws.lastRow!.getCell(1).value).toBe(3234.5);
  });

  it('leaves an omitted key blank rather than shifting the row', async () => {
    const ws = (
      await reopen(
        await buildSheet({
          sheets: [
            {
              name: 'S',
              columns: [
                { key: 'a', header: 'A' },
                { key: 'b', header: 'B' },
                { key: 'c', header: 'C' },
              ],
              rows: [{ a: 'a1', c: 'c1' }],
            },
          ],
        }),
      )
    ).worksheets[0]!;
    const row = ws.getRow(2);
    expect(row.getCell(1).value).toBe('a1');
    expect(row.getCell(2).value).toBeNull();
    expect(row.getCell(3).value).toBe('c1'); // still in column C, not shifted left
  });

  it('does not give a row COUNT the money format of its column', async () => {
    const ws = (
      await reopen(
        await buildSheet({
          sheets: [
            {
              name: 'S',
              columns: [
                { key: 'ref', header: 'Ref' },
                { key: 'amt', header: 'Amt', type: 'currency' },
              ],
              rows: [
                { ref: 'a', amt: 1 },
                { ref: 'b', amt: 2 },
              ],
              totals: { amt: 'count' },
            },
          ],
        }),
      )
    ).worksheets[0]!;
    expect(ws.lastRow!.getCell(2).value).toBe(2);
    expect(String(ws.lastRow!.getCell(2).numFmt ?? '')).not.toContain('USD');
  });
});

describe('buildSheet — presentation', () => {
  it('freezes past the title block, and filters only the data', async () => {
    const ws = (await reopen(await buildSheet(INVOICES))).worksheets[0]!;
    // Header sits on row 3, so the freeze must too — freezing at row 1 would
    // scroll the header away and pin the title instead.
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 3 });
    expect(ws.autoFilter).toBe('A3:F5'); // header + 2 rows, never the totals
  });

  it('bands alternate rows under the report style and not under compact', async () => {
    const spec = (style: 'report' | 'compact' | 'plain'): WorkbookSpec => ({
      sheets: [
        {
          name: 'S',
          style,
          columns: [{ key: 'a', header: 'A' }],
          rows: [{ a: '1' }, { a: '2' }, { a: '3' }],
        },
      ],
    });
    const report = (await reopen(await buildSheet(spec('report')))).worksheets[0]!;
    expect(fillOf(report.getRow(3).getCell(1))).toBe('FFF5F6F8');
    const compact = (await reopen(await buildSheet(spec('compact')))).worksheets[0]!;
    expect(fillOf(compact.getRow(3).getCell(1))).toBeUndefined();
  });

  it('paints no fills at all under the plain style', async () => {
    const ws = (
      await reopen(
        await buildSheet({
          sheets: [
            {
              name: 'S',
              style: 'plain',
              columns: [{ key: 'a', header: 'A' }],
              rows: [{ a: '1' }, { a: '2' }],
              totals: { a: 'count' },
            },
          ],
        }),
      )
    ).worksheets[0]!;
    expect(fillOf(ws.getRow(1).getCell(1))).toBeUndefined(); // header
    expect(fillOf(ws.lastRow!.getCell(1))).toBeUndefined(); // totals
    expect(ws.getRow(1).getCell(1).font?.bold).toBe(true); // still legible as a header
  });

  it('sizes a money column for what it DISPLAYS, not what it stores', async () => {
    const ws = (await reopen(await buildSheet(INVOICES))).worksheets[0]!;
    // 'ZAR 17,320.50' is 13 characters; the stored 12500 is 5.
    expect(ws.getColumn(2).width!).toBeGreaterThanOrEqual(13);
  });

  it('freezes leading columns when asked, without freezing the whole sheet', async () => {
    const ws = (
      await reopen(
        await buildSheet({
          sheets: [
            {
              name: 'S',
              columns: [
                { key: 'a', header: 'A' },
                { key: 'b', header: 'B' },
              ],
              rows: [{ a: '1', b: '2' }],
              freeze_columns: 9, // more than exist
            },
          ],
        }),
      )
    ).worksheets[0]!;
    expect(ws.views[0]).toMatchObject({ xSplit: 1 }); // clamped to width - 1
  });

  it('suffixes colliding sheet names rather than throwing', async () => {
    const wb = await reopen(
      await buildSheet({
        sheets: [
          { name: 'Q1/Q2', columns: [{ key: 'a', header: 'A' }], rows: [] },
          { name: 'Q1?Q2', columns: [{ key: 'a', header: 'A' }], rows: [] },
        ],
      }),
    );
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Q1 Q2', 'Q1 Q2 (2)']);
  });
});

describe('buildSheet — the spec is checked before anything is written', () => {
  const base = (over: Record<string, unknown>): WorkbookSpec =>
    ({
      sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], rows: [], ...over }],
    }) as WorkbookSpec;

  it('names the offending key when a row uses one that does not exist', async () => {
    await expect(buildSheet(base({ rows: [{ amout: 1 }] }))).rejects.toThrow(
      /unknown column key 'amout'.*expected: a/s,
    );
  });

  it('rejects a positional array row, and says why', async () => {
    await expect(buildSheet(base({ rows: [['a1']] }))).rejects.toThrow(
      /shifted value looks correct/,
    );
  });

  it('rejects duplicate column keys', async () => {
    await expect(
      buildSheet(
        base({
          columns: [
            { key: 'a', header: 'A' },
            { key: 'a', header: 'Also A' },
          ],
        }),
      ),
    ).rejects.toThrow(/duplicate column key 'a'/);
  });

  it('rejects totals on a column that is not there', async () => {
    await expect(buildSheet(base({ totals: { nope: 'sum' } }))).rejects.toThrow(
      /totals reference unknown column 'nope'/,
    );
  });

  it('points a too-big sheet at tables instead', async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({ a: String(i) }));
    await expect(buildSheet(base({ rows }))).rejects.toThrow(/import data as a table instead/);
  });

  it('throws SheetSpecError, so the caller can pass the message straight back', async () => {
    await expect(buildSheet({ sheets: [] })).rejects.toBeInstanceOf(SheetSpecError);
  });
});
