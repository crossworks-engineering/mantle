/**
 * A big real workbook reads; a zip bomb does not (2026-11-25). Plant
 * registers on client boxes hold sheets that unpack to 169 MB to 1 GB of
 * XML, packed 4 to 13 times, and every one ended `document_unreadable`:
 * the zip guard held each part to 128 MB. A sheet is read as a stream
 * (./sheet-read.ts), so the guard now holds it to a ratio only
 * (./zip-guard.ts, MAX_ZIP_STREAM_RATIO). Made-up data only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { constants, crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zipOf, type ZipEntry } from './bombs.test-helper';
import { readDocumentText } from './read-document';
import { withReadCutSink } from './read-cut-sink';
import { isDocumentTooLarge } from './read-limit';
import { readEmbeddedImages } from './embedded-images-read';
import { parseSheetToGrid, type SpillTo } from './sheet-grid';
import { sheetXmlBytes } from './sheet-read';
import { fileDbRowsSpill } from './sheet-spill';
import { fileDbRowKeeper } from './sheet-to-grid';
import {
  assertZipWithinLimits,
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_STREAM_RATIO,
  MAX_ZIP_TOTAL_BYTES,
} from './zip-guard';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** The parts of a one-sheet workbook around its sheet. */
function workbookParts(sheet: ZipEntry): ZipEntry[] {
  return [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Register" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    sheet,
  ];
}

/** A register sheet of `rows` rows: a header, then rows of a tag, a
 *  number and text that differ row to row, so it packs about as a real
 *  sheet does (some ten times), not as a bomb. Deflated a slice at a time,
 *  so the whole XML is never one string. */
function registerSheet(rows: number): ZipEntry {
  const head = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Tag</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c><c r="C1" t="inlineStr"><is><t>Note</t></is></c></row>`;
  const tail = '</sheetData></worksheet>';
  const parts: Buffer[] = [];
  let slice: string[] = [head];
  let crc = 0;
  let size = 0;
  let seed = 7;
  const flush = (final: boolean) => {
    const text = Buffer.from(slice.join(''));
    crc = crc32(text, crc);
    size += text.length;
    const finishFlush = final ? constants.Z_FINISH : constants.Z_FULL_FLUSH;
    parts.push(deflateRawSync(text, { level: 1, finishFlush }));
    slice = [];
  };
  for (let r = 2; r <= rows + 1; r++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const tag = `P-${(seed % 99991).toString(36).toUpperCase()}-${r}`;
    slice.push(
      `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>${tag}</t></is></c><c r="B${r}"><v>${(seed % 1000003) / 7}</v></c><c r="C${r}" t="inlineStr"><is><t>line ${seed % 977} unit ${r % 61} area ${seed % 13}</t></is></c></row>`,
    );
    if (slice.length >= 20_000) flush(false);
  }
  slice.push(tail);
  flush(true);
  return {
    name: 'xl/worksheets/sheet1.xml',
    deflated: { body: Buffer.concat(parts), crc, size },
  };
}

describe('a big real sheet reads', () => {
  it('a sheet past the part cap, packed as a real one, reads in full to the file database', async () => {
    // Past 128 MB of XML, about ten times packed.
    const rows = 800_000;
    const xlsx = zipOf(workbookParts(registerSheet(rows)));
    const sizes = await assertZipWithinLimits(xlsx, { sheets: true });
    const sheet = sizes.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toBeGreaterThan(MAX_ZIP_ENTRY_BYTES);
    expect(sheet / xlsx.length).toBeLessThan(MAX_ZIP_STREAM_RATIO / 4);

    // The text read: its first rows, the cut said (no more `too_large`).
    const { value: text, cuts } = await withReadCutSink(() => readDocumentText(xlsx, 'xlsx'));
    expect(text).toContain('# Sheet: Register');
    expect(cuts.sheet_rows).toMatchObject({ read: 5_000, atLeast: true });

    // The picture read: none, and no refusal.
    expect((await readEmbeddedImages(xlsx, 'xlsx')).images).toEqual([]);

    // The file database read, as the package `sheet` does it: every row
    // to the rows file.
    const dir = mkdtempSync(path.join(tmpdir(), 'big-sheet-'));
    try {
      const to: SpillTo = { open: () => fileDbRowsSpill(dir, Date.now() + 100_000), spilled: [] };
      const tabs = await parseSheetToGrid(xlsx, fileDbRowKeeper(), to);
      expect(tabs.map((t) => t.name)).toEqual(['Register']);
      expect(to.spill?.cut()).toBeNull();
      expect(to.spilled.map((t) => t.rows)).toEqual([rows]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('a zip bomb is still refused', () => {
  /** A sheet that claims 1 KB and unpacks to `bytes` of one repeated row:
   *  about a thousand times its packed size. */
  const ROWS = '<row><c t="inlineStr"><is><t>bomb</t></is></c></row>'.repeat(20_000);
  const sheetBomb = (bytes: number): Buffer =>
    zipOf(
      workbookParts({
        name: 'xl/worksheets/sheet1.xml',
        repeat: {
          head: `<?xml version="1.0"?><worksheet xmlns="${NS}"><sheetData>`,
          chunk: ROWS,
          times: Math.ceil(bytes / ROWS.length),
          tail: '</sheetData></worksheet>',
        },
        declaredSize: 1024,
      }),
    );

  it('by the text read, the picture read and the file database read', async () => {
    const bomb = sheetBomb(400 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    for (const read of [
      () => readDocumentText(bomb, 'xlsx'),
      () => readEmbeddedImages(bomb, 'xlsx'),
      () => parseSheetToGrid(bomb, fileDbRowKeeper()),
      () => parseSheetToGrid(bomb),
    ]) {
      const err = await read().catch((e: unknown) => e);
      expect(isDocumentTooLarge(err), String(err)).toBe(true);
      expect(String((err as Error).message)).toContain('zip bomb');
    }
  }, 60_000);

  it('a sheet with a corrupt tail counts what it unpacked, so it is never read whole', async () => {
    // 40 MB of rows (past the whole reader's 32 MB), then bytes that are no
    // deflate data: the size is what came out before the error, not 0.
    const good = sheetBomb(40 * 1024 * 1024);
    const zip = await import('jszip').then((m) => m.default.loadAsync(good));
    const data = (
      zip.file('xl/worksheets/sheet1.xml') as unknown as {
        _data: { compressedContent: Uint8Array };
      }
    )._data.compressedContent;
    // The last bytes of the stream (its final block) are cut and replaced.
    const at = good.lastIndexOf(Buffer.from(data.subarray(data.length - 16)));
    const broken = Buffer.from(good);
    broken.fill(0xff, at, at + 16);
    // The part really is corrupt now: a whole inflate of it fails.
    const bad = await import('jszip').then((m) => m.default.loadAsync(broken));
    const badData = (
      bad.file('xl/worksheets/sheet1.xml') as unknown as {
        _data: { compressedContent: Uint8Array };
      }
    )._data.compressedContent;
    expect(() => inflateRawSync(badData)).toThrow();
    const sizes = await assertZipWithinLimits(broken, { sheets: true });
    expect(sizes.get('xl/worksheets/sheet1.xml')).toBeGreaterThan(32 * 1024 * 1024);
  });

  it('under the part cap a sheet is read as before, whatever it packs to', async () => {
    const small = sheetBomb(8 * 1024 * 1024);
    const sizes = await assertZipWithinLimits(small, { sheets: true });
    const sheet = sizes.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toBeGreaterThan(8 * 1024 * 1024);
    expect(sheet / small.length).toBeGreaterThan(MAX_ZIP_STREAM_RATIO);
  });

  it('a part read whole keeps the flat caps, and a sheet is not counted in the total', async () => {
    const doc = (name: string, bytes: number): ZipEntry => ({
      name,
      repeat: { chunk: 'x'.repeat(1 << 20), times: Math.ceil(bytes / (1 << 20)) },
    });
    // A shared strings part (read whole) past the part cap: refused.
    const strings = zipOf([doc('xl/sharedStrings.xml', MAX_ZIP_ENTRY_BYTES + (1 << 20))]);
    expect(isDocumentTooLarge(await assertZipWithinLimits(strings).catch((e) => e))).toBe(true);
    // A part read whole and a sheet that add up past the file's total:
    // read, the sheet is not counted in it.
    const both = await assertZipWithinLimits(
      zipOf([doc('xl/sharedStrings.xml', 100 << 20), doc('xl/worksheets/sheet1.xml', 100 << 20)]),
      { maxEntryBytes: 200 << 20, maxTotalBytes: 150 << 20, sheets: true },
    );
    expect(both.size).toBe(2);
    expect(MAX_ZIP_TOTAL_BYTES).toBe(512 * 1024 * 1024);
  }, 60_000);

  it('sheets whose entries overlap are held to one budget for them all', async () => {
    // Each entry's data holds the next entry (a stored block wraps its local
    // header): N sheets share one packed kernel, each under its own rule,
    // all together far past 100 times the file.
    const N = 200;
    const raw = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < raw.length; i++) raw[i] = (((i * 2654435761) >>> 24) & 0x0f) | 0x40;
    const kernel = deflateRawSync(raw, { level: 9 });
    const header = (name: Buffer, csize: number, usize: number) => {
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(8, 8);
      h.writeUInt32LE(csize, 18);
      h.writeUInt32LE(usize, 22);
      h.writeUInt16LE(name.length, 26);
      return Buffer.concat([h, name]);
    };
    const names = Array.from({ length: N }, (_, k) =>
      Buffer.from(`xl/worksheets/sheet${k + 1}.xml`),
    );
    const heads: Buffer[] = new Array(N);
    const csizes: number[] = new Array(N);
    heads[N - 1] = header(names[N - 1]!, kernel.length, raw.length);
    csizes[N - 1] = kernel.length;
    let body = Buffer.concat([heads[N - 1]!, kernel]);
    for (let k = N - 2; k >= 0; k--) {
      const next = heads[k + 1]!;
      const stored = Buffer.alloc(5);
      stored.writeUInt16LE(next.length, 1);
      stored.writeUInt16LE(next.length ^ 0xffff, 3);
      csizes[k] = 5 + body.length;
      heads[k] = header(names[k]!, csizes[k]!, 0);
      body = Buffer.concat([heads[k]!, stored, body]);
    }
    const central: Buffer[] = [];
    let off = 0;
    for (let k = 0; k < N; k++) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(8, 10);
      c.writeUInt32LE(csizes[k]!, 20);
      c.writeUInt32LE(1000, 24);
      c.writeUInt16LE(names[k]!.length, 28);
      c.writeUInt32LE(off, 42);
      central.push(c, names[k]!);
      off += heads[k]!.length + 5;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(N, 8);
    end.writeUInt16LE(N, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(body.length, 16);
    const zip = Buffer.concat([body, cd, end]);
    expect(N * raw.length).toBeGreaterThan(MAX_ZIP_TOTAL_BYTES);
    expect(N * raw.length).toBeGreaterThan(MAX_ZIP_STREAM_RATIO * zip.length);
    const err = await assertZipWithinLimits(zip, { sheets: true }).catch((e: unknown) => e);
    expect(isDocumentTooLarge(err), String(err)).toBe(true);
    expect(String((err as Error).message)).toContain("times the file's size");
  }, 60_000);

  it('outside a workbook a part named like a sheet keeps the flat cap', async () => {
    // A docx can name its document part like a sheet; mammoth reads it whole.
    const doc = zipOf([
      {
        name: 'xl/worksheets/sheet1.xml',
        repeat: { chunk: ROWS, times: Math.ceil((MAX_ZIP_ENTRY_BYTES + (1 << 20)) / ROWS.length) },
      },
    ]);
    for (const read of [
      () => assertZipWithinLimits(doc),
      () => readDocumentText(doc, 'docx'),
      () => readEmbeddedImages(doc, 'docx'),
    ]) {
      const err = await read().catch((e: unknown) => e);
      expect(isDocumentTooLarge(err), String(err)).toBe(true);
      expect(String((err as Error).message)).toContain('past what one part of a document may');
    }
  }, 60_000);

  it('a sheet under a name exceljs still reads as a sheet is measured as one', async () => {
    // exceljs's whole reader takes any name holding xl/worksheets/sheetN.xml
    // as a sheet: such a part counts for its 32 MB check too.
    for (const name of ['xl/worksheets/sheet1.xml.bak', '/xl/worksheets/sheet1.xml']) {
      const renamed = zipOf(
        workbookParts({
          name,
          repeat: { chunk: ROWS, times: Math.ceil((40 * 1024 * 1024) / ROWS.length) },
        }),
      );
      expect(await sheetXmlBytes(renamed), name).toBeGreaterThan(32 * 1024 * 1024);
    }
  });
});
