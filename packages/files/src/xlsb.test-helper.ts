/**
 * A binary Excel workbook (.xlsb) written from scratch for the tests: the
 * package and workbook relationships, `xl/workbook.bin` with one BrtBundleSh
 * per sheet, and per sheet a part of BrtRowHdr and BrtCellReal records, with
 * a BrtWsDim that can tell the truth, lie, or be left out. No shared strings
 * or styles: numbers only. References: [MS-XLSB] 2.1.4 (record framing),
 * 2.4 (records).
 */

import JSZip from 'jszip';

/** One record: a 1-2 byte type and a 1-4 byte size, 7 bits a byte. */
function rec(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const head: number[] = type < 0x80 ? [type] : [(type & 0x7f) | 0x80, type >> 7];
  let size = body.length;
  do {
    const low = size & 0x7f;
    size >>= 7;
    head.push(size > 0 ? low | 0x80 : low);
  } while (size > 0);
  return Buffer.concat([Buffer.from(head), body]);
}

function u32s(...values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
  return b;
}

function wide(s: string): Buffer {
  return Buffer.concat([u32s(s.length), Buffer.from(s, 'utf16le')]);
}

export type XlsbSheet = {
  name: string;
  /** (row, column, value), zero-based. */
  cells: Array<[number, number, number]>;
  /** What BrtWsDim declares (default: the truth), or `null` for none. */
  dimension?: { rows: number; cols: number } | null;
  hidden?: boolean;
};

function sheetPart(sheet: XlsbSheet): Buffer {
  const out: Buffer[] = [rec(0x0181)]; // BrtBeginSheet
  let rows = 0;
  let cols = 0;
  for (const [r, c] of sheet.cells) {
    rows = Math.max(rows, r + 1);
    cols = Math.max(cols, c + 1);
  }
  const dim = sheet.dimension === undefined ? { rows, cols } : sheet.dimension;
  if (dim) out.push(rec(0x0094, u32s(0, Math.max(0, dim.rows - 1), 0, Math.max(0, dim.cols - 1))));
  out.push(rec(0x0191)); // BrtBeginSheetData
  const byRow = new Map<number, Array<[number, number]>>();
  for (const [r, c, v] of sheet.cells) byRow.set(r, [...(byRow.get(r) ?? []), [c, v]]);
  for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
    // BrtRowHdr: rw, ixfe, miyRw, two flag bytes, then the column spans
    // count (0 here).
    out.push(rec(0x0000, Buffer.concat([u32s(r, 0), Buffer.from([0, 0, 0, 0]), u32s(0)])));
    for (const [c, v] of byRow.get(r)!) {
      const value = Buffer.alloc(8);
      value.writeDoubleLE(v, 0);
      out.push(rec(0x0005, Buffer.concat([u32s(c, 0), value]))); // BrtCellReal
    }
  }
  out.push(rec(0x0192), rec(0x0182)); // BrtEndSheetData, BrtEndSheet
  return Buffer.concat(out);
}

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** An `.xlsb` holding the sheets, in order. */
export async function xlsbFile(sheets: XlsbSheet[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.bin"/></Relationships>`,
  );
  const bundles = sheets.map((s, i) =>
    rec(156, Buffer.concat([u32s(s.hidden ? 1 : 0, i + 1), wide(`rId${i + 1}`), wide(s.name)])),
  );
  zip.file('xl/workbook.bin', Buffer.concat([rec(0x0183), ...bundles, rec(0x0184)]));
  zip.file(
    'xl/_rels/workbook.bin.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.bin"/>`,
      )
      .join('')}</Relationships>`,
  );
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.bin`, sheetPart(s)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
