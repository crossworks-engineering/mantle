/**
 * Test-only workbook builders.
 *
 * Fixtures are written with exceljs — the same engine the readers use. That is
 * a deliberate weakness to be aware of: a round trip through one library can
 * hide a bug that only bites on someone else's file. The cases where the
 * PRODUCER matters (a phantom used-range, an odd zip layout) are therefore
 * built by rewriting the package's XML directly, not by asking exceljs for it.
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

/** Build an .xlsx buffer from an array-of-arrays per sheet. `undefined` and
 *  `null` leave a cell genuinely empty, so short and sparse rows stay short. */
export async function workbookBuffer(sheets: Record<string, unknown[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((row, r) => {
      const target = ws.getRow(r + 1);
      row.forEach((value, c) => {
        if (value === undefined || value === null) return;
        target.getCell(c + 1).value = value as ExcelJS.CellValue;
      });
      target.commit();
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Rewrite a workbook's `<dimension>` to claim the whole grid while leaving the
 * real cells alone — the shape that used to hang ingest for minutes under
 * SheetJS, because it walked the DECLARED range rather than the real one.
 */
export async function withPhantomDimension(buf: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  const path = Object.keys(zip.files).find((f) => /^xl\/worksheets\/sheet1\.xml$/.test(f));
  if (!path) throw new Error('fixture has no sheet1.xml');
  const xml = await zip.file(path)!.async('string');
  const phantom = '<dimension ref="A1:XFD1048576"/>';
  zip.file(
    path,
    /<dimension[^>]*\/>/.test(xml)
      ? xml.replace(/<dimension[^>]*\/>/, phantom)
      : xml.replace(/(<worksheet[^>]*>)/, `$1${phantom}`),
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
