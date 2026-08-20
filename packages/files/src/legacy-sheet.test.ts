import { beforeEach, describe, expect, it, vi } from 'vitest';

const parseTikaBytes = vi.fn<(bytes: Buffer, opts?: unknown) => Promise<string>>();
vi.mock('./tika', () => ({
  parseTikaBytes: (bytes: Buffer, opts?: unknown) => parseTikaBytes(bytes, opts),
}));

const { convertLegacySheetToXlsx, isLegacySheetExt } = await import('./legacy-sheet');
const { parseSheetToGrid } = await import('./sheet-to-grid');
const { parseXlsx } = await import('./xlsx');

/** Real Apache Tika 3.3.1 XHTML for a two-sheet .xls, captured verbatim —
 *  including the `&#0;` title that makes the document as a whole invalid XML,
 *  and the trailing boolean Tika drops rather than renders. */
const TIKA_XHTML = `<html xmlns="http://www.w3.org/1999/xhtml">
    <head>
        <meta name="X-TIKA:Parsed-By" content="org.apache.tika.parser.microsoft.OfficeParser"/>
        <meta name="Content-Type" content="application/vnd.ms-excel"/>
        <title>&#0;</title>
    </head>
    <body>
        <div class="page">
            <h1>Orders</h1>
            <table><tbody>
                <tr><td>Name</td><td>Qty</td><td>Price</td><td>Active</td></tr>
                <tr><td>Widget</td><td>3</td><td>12.5</td></tr>
                <tr><td>Gadget</td><td>10</td><td>4.25</td></tr>
            </tbody></table>
        </div>
        <div class="page">
            <h1>Notes</h1>
            <table><tbody>
                <tr><td>Note</td></tr>
                <tr><td>second sheet, one column</td></tr>
            </tbody></table>
        </div>
    </body>
</html>`;

const XLS = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

beforeEach(() => parseTikaBytes.mockReset());

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
  it('asks Tika for XHTML, not plain text', async () => {
    parseTikaBytes.mockResolvedValue(TIKA_XHTML);
    await convertLegacySheetToXlsx(XLS, 'application/vnd.ms-excel');
    expect(parseTikaBytes).toHaveBeenCalledWith(
      XLS,
      expect.objectContaining({ accept: 'text/html', mimeType: 'application/vnd.ms-excel' }),
    );
  });

  it('produces a workbook the ordinary exceljs reader can parse', async () => {
    parseTikaBytes.mockResolvedValue(TIKA_XHTML);
    const xlsx = await convertLegacySheetToXlsx(XLS, 'application/vnd.ms-excel');
    expect(xlsx).not.toBeNull();

    const text = await parseXlsx(xlsx!);
    expect(text).toContain('# Sheet: Orders');
    expect(text).toContain('# Sheet: Notes');
    expect(text).toContain('Widget,3,12.5');
  });

  it('keeps numeric columns numeric through the round trip', async () => {
    parseTikaBytes.mockResolvedValue(TIKA_XHTML);
    const xlsx = await convertLegacySheetToXlsx(XLS, 'application/vnd.ms-excel');
    const [orders] = await parseSheetToGrid(xlsx!);
    expect(orders!.name).toBe('Orders');
    expect(orders!.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      'Name:text',
      'Qty:number',
      'Price:number',
      // The documented loss: Tika renders a boolean cell as empty, so the
      // column survives (by its header) with no values to type.
      'Active:text',
    ]);
    expect(orders!.rows).toEqual([
      ['Widget', 3, 12.5, null],
      ['Gadget', 10, 4.25, null],
    ]);
  });

  it('preserves column alignment when an interior cell is empty', async () => {
    parseTikaBytes.mockResolvedValue(
      `<html><body><div class="page"><h1>S</h1><table><tbody>` +
        `<tr><td>A</td><td>Flag</td><td>C</td></tr>` +
        `<tr><td>a1</td><td/><td>c1</td></tr>` +
        `</tbody></table></div></body></html>`,
    );
    const xlsx = await convertLegacySheetToXlsx(XLS, 'application/vnd.ms-excel');
    const [sheet] = await parseSheetToGrid(xlsx!);
    expect(sheet!.rows).toEqual([['a1', null, 'c1']]);
  });

  it('returns null when Tika is unavailable', async () => {
    parseTikaBytes.mockResolvedValue('');
    expect(await convertLegacySheetToXlsx(XLS, 'application/vnd.ms-excel')).toBeNull();
  });

  it('returns null when the response holds no tables', async () => {
    parseTikaBytes.mockResolvedValue(
      '<html><body><div class="page"><p>no grid</p></div></body></html>',
    );
    expect(await convertLegacySheetToXlsx(XLS, 'application/vnd.ms-excel')).toBeNull();
  });

  it('sanitises a sheet name Excel would reject', async () => {
    parseTikaBytes.mockResolvedValue(
      `<html><body><div class="page"><h1>Q1/Q2 [draft]: a very long tab name indeed</h1>` +
        `<table><tbody><tr><td>x</td></tr></tbody></table></div></body></html>`,
    );
    const xlsx = await convertLegacySheetToXlsx(XLS, 'application/vnd.ms-excel');
    const [sheet] = await parseSheetToGrid(xlsx!);
    expect(sheet!.name).toBe('Q1 Q2  draft   a very long tab '); // no \ / ? * [ ] :
    expect(sheet!.name.length).toBe(31); // Excel's hard cap on a tab name
  });
});
