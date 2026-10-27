/**
 * Decompression bombs and other hostile documents, built in memory for the
 * resource-limit tests. Nothing here is a real document: each is the
 * smallest file that makes a reader ask for far more than it should.
 *
 * The zip writer is hand-rolled because JSZip (and every zip library) needs
 * the uncompressed entry in memory to write it, and the point of a bomb is an
 * entry far larger than memory. A deflate stream of one repeated chunk is
 * made by compressing the chunk once with a full flush (byte-aligned,
 * dictionary reset, not final) and repeating those bytes, then one empty
 * final block. The CRC is computed over the repeats the same way.
 */
import { crc32, constants, deflateRawSync } from 'node:zlib';

export type ZipEntry =
  | { name: string; data: Buffer | string; store?: boolean }
  | {
      name: string;
      /** The uncompressed content is `head`, then `chunk` repeated `times`
       *  times, then `tail`. */
      repeat: { head?: string; chunk: Buffer | string; times: number; tail?: string };
      /** Write this as the uncompressed size instead of the real one. */
      declaredSize?: number;
    };

type Built = { name: Buffer; method: number; crc: number; size: number; body: Buffer };

function build(entry: ZipEntry): Built {
  const name = Buffer.from(entry.name, 'utf8');
  if ('repeat' in entry) {
    const { times } = entry.repeat;
    const head = Buffer.from(entry.repeat.head ?? '');
    const chunk = Buffer.from(entry.repeat.chunk);
    const tail = Buffer.from(entry.repeat.tail ?? '');
    const flush = { level: 9, finishFlush: constants.Z_FULL_FLUSH };
    const body = Buffer.concat([
      deflateRawSync(head, flush),
      ...Array<Buffer>(times).fill(deflateRawSync(chunk, flush)),
      deflateRawSync(tail),
    ]);
    let crc = crc32(head);
    for (let i = 0; i < times; i++) crc = crc32(chunk, crc);
    crc = crc32(tail, crc);
    const real = head.length + chunk.length * times + tail.length;
    return { name, method: 8, crc, size: entry.declaredSize ?? real, body };
  }
  const data = Buffer.from(entry.data);
  if (entry.store) return { name, method: 0, crc: crc32(data), size: data.length, body: data };
  return { name, method: 8, crc: crc32(data), size: data.length, body: deflateRawSync(data) };
}

/** A zip of the entries, in order, no zip64 (keep each under 4 GB). */
export function zipOf(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries.map(build)) {
    const size = Math.min(e.size, 0xffffffff);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(e.crc >>> 0, 14);
    local.writeUInt32LE(e.body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(e.name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(e.method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(e.crc >>> 0, 16);
    central.writeUInt32LE(e.body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(e.name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, e.name, e.body);
    centrals.push(central, e.name);
    offset += local.length + e.name.length + e.body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const ODS_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';

/** An OpenDocument spreadsheet whose content.xml repeats one row of `cols`
 *  cells of `textLen` characters `rows` times, deflated: under 1 MB on disk.
 *  The default (4,000 x 64 x 300) stays inside anydoc's own limits and
 *  unpacks to about 80 MB of XML and 77 MB of Markdown, the shape that held
 *  hundreds of MB resident in the server; 20,000 x 64 with short text
 *  crosses anydoc's 2-million-node limit instead. */
export function odsBomb(rows = 4_000, cols = 64, textLen = 300): Buffer {
  const cell = `<table:table-cell office:value-type="string"><text:p>${'x'.repeat(textLen)}</text:p></table:table-cell>`;
  const chunk = `<table:table-row>${cell.repeat(cols)}</table:table-row>`;
  const times = rows;
  const head = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODS_NS} office:version="1.2"><office:body><office:spreadsheet><table:table table:name="Sheet1">`;
  const tail = '</table:table></office:spreadsheet></office:body></office:document-content>';
  return zipOf([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet', store: true },
    {
      name: 'META-INF/manifest.xml',
      data: '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
    },
    { name: 'content.xml', repeat: { head, chunk, times, tail } },
  ]);
}

/** A Visio drawing whose one page part inflates to `bytes` of shape text
 *  (1.47 GB by default). `declare` sets the size the zip claims for it; a
 *  lying header (`declare` small) gets past an honest size check and must be
 *  stopped by the worker's own limits. */
export function vsdxBomb(bytes = 1_470_000_000, declare?: number): Buffer {
  const chunk = Buffer.from('<Shape><Text>bomb</Text></Shape>'.repeat(32_768));
  const times = Math.ceil(bytes / chunk.length);
  return zipOf([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    {
      name: 'visio/pages/page1.xml',
      repeat: { chunk, times },
      ...(declare !== undefined ? { declaredSize: declare } : {}),
    },
  ]);
}

/** An `.xlsx` holding only A1 and the cell at (`lastRow`, `lastCol`), the
 *  shape that turns into a rows x cols grid when rendered as a table. */
export function sparseXlsx(lastRow = 10_000, lastCol = 200): Buffer {
  const colName = (n: number): string => {
    let s = '';
    for (let c = n; c > 0; c = Math.floor((c - 1) / 26))
      s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
    return s;
  };
  const ref = `${colName(lastCol)}${lastRow}`;
  return zipOf([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row><row r="${lastRow}"><c r="${ref}" t="inlineStr"><is><t>b</t></is></c></row></sheetData></worksheet>`,
    },
  ]);
}

/** A `.docx` whose document part inflates to `bytes` (300 MB by default)
 *  behind a directory that claims 1 KB: mammoth would inflate it whole. */
export function docxBomb(bytes = 300_000_000): Buffer {
  const chunk = Buffer.from('<w:p><w:r><w:t>bomb</w:t></w:r></w:p>'.repeat(16_384));
  return zipOf([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    {
      name: 'word/document.xml',
      repeat: { chunk, times: Math.ceil(bytes / chunk.length) },
      declaredSize: 1_000,
    },
  ]);
}

/** A `.pptx` of one slide whose part is `body`: the shapes that made the
 *  regular-expression scanners quadratic (an `<a:t>` with no close, an
 *  attribute run with no `>`). */
export function hostilePptx(body: string): Buffer {
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
  return zipOf([
    {
      name: 'ppt/presentation.xml',
      data: '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: `<Relationships><Relationship Id="rId1" Type="${rel}" Target="slides/slide1.xml"/></Relationships>`,
    },
    { name: 'ppt/slides/slide1.xml', data: `<p:sld>${body}</p:sld>` },
  ]);
}
