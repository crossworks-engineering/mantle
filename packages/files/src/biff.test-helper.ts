/**
 * A real binary Excel 97-2003 workbook (BIFF8 in an OLE2 compound file),
 * written from scratch for the tests: no client file, no tool, nothing
 * downloaded. Enough of the format for a reader: the workbook globals (BOF,
 * one BOUNDSHEET per sheet, a shared string table, EOF) and per sheet a BOF,
 * DIMENSIONS, NUMBER and LABELSST cells, EOF. The compound file has one FAT
 * sector, one directory sector and the Workbook stream in ordinary sectors
 * (padded past the 4,096-byte mini-stream cutoff with WRITEACCESS records,
 * the blank-padded user-name record Excel itself writes, so no mini stream
 * is needed).
 *
 * References: [MS-XLS] 2.4 (records) and [MS-CFB] 2.2 to 2.6 (container).
 */

type Cell = string | number;
export type BiffSheet = { name: string; rows: Cell[][] };

function record(type: number, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(body.length, 2);
  return Buffer.concat([head, body]);
}

function bof(dt: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(0x0600, 0); // BIFF8
  b.writeUInt16LE(dt, 2); // 0x0005 globals, 0x0010 worksheet
  b.writeUInt16LE(0x0dbb, 4); // build
  b.writeUInt16LE(0x07cc, 6); // year
  return record(0x0809, b);
}

const EOF = record(0x000a, Buffer.alloc(0));

/** A BIFF8 unicode string: 8-bit when it fits, with its length prefix. */
function xlString(text: string, lengthBytes: 1 | 2): Buffer {
  const wide = [...text].some((c) => c.charCodeAt(0) > 0xff);
  const chars = wide ? Buffer.from(text, 'utf16le') : Buffer.from(text, 'latin1');
  const head = Buffer.alloc(lengthBytes + 1);
  if (lengthBytes === 1) head.writeUInt8(text.length, 0);
  else head.writeUInt16LE(text.length, 0);
  head.writeUInt8(wide ? 1 : 0, lengthBytes);
  return Buffer.concat([head, chars]);
}

function sheetStream(sheet: BiffSheet, sst: Map<string, number>): Buffer {
  // Rows and cells may be sparse (holes): a grid holding A1 and IV65536.
  const rows = sheet.rows.length;
  let cols = 0;
  sheet.rows.forEach((r) => (cols = Math.max(cols, r.length)));
  const dims = Buffer.alloc(14);
  dims.writeUInt32LE(0, 0);
  dims.writeUInt32LE(rows, 4);
  dims.writeUInt16LE(0, 8);
  dims.writeUInt16LE(cols, 10);
  const cells: Buffer[] = [];
  sheet.rows.forEach((row, r) =>
    row.forEach((value, c) => {
      if (typeof value === 'number') {
        const b = Buffer.alloc(14);
        b.writeUInt16LE(r, 0);
        b.writeUInt16LE(c, 2);
        b.writeUInt16LE(15, 4); // the default cell XF
        b.writeDoubleLE(value, 6);
        cells.push(record(0x0203, b));
      } else {
        const b = Buffer.alloc(10);
        b.writeUInt16LE(r, 0);
        b.writeUInt16LE(c, 2);
        b.writeUInt16LE(15, 4);
        b.writeUInt32LE(sst.get(value)!, 6);
        cells.push(record(0x00fd, b));
      }
    }),
  );
  return Buffer.concat([bof(0x0010), record(0x0200, dims), ...cells, EOF]);
}

/** The minimal style table a reader expects: 15 style XFs and one cell XF
 *  (index 15), all on font 0 and the General format, and that font. */
function styles(): Buffer[] {
  const font = Buffer.concat([
    (() => {
      const b = Buffer.alloc(14);
      b.writeUInt16LE(200, 0); // 10 pt
      b.writeUInt16LE(0x7fff, 4); // automatic colour
      b.writeUInt16LE(400, 6); // normal weight
      return b;
    })(),
    xlString('Arial', 1),
  ]);
  const xf = (style: boolean) => {
    const b = Buffer.alloc(20);
    b.writeUInt16LE(0, 0); // font
    b.writeUInt16LE(0, 2); // General
    b.writeUInt16LE(style ? 0xfff5 : 0x0001, 4); // style XF / locked cell XF
    b.writeUInt16LE(0x0020, 6);
    return record(0x00e0, b);
  };
  return [
    ...Array.from({ length: 5 }, () => record(0x0031, font)), // font 4 is skipped by readers
    ...Array.from({ length: 15 }, () => xf(true)),
    xf(false),
  ];
}

/** WRITEACCESS: the user name, blank-padded to 112 bytes. Readers skip it. */
const WRITEACCESS = record(
  0x005c,
  Buffer.concat([xlString('test', 2), Buffer.alloc(112 - 7, 0x20)]),
);

/** The Workbook stream: globals, then each sheet, BOUNDSHEET offsets set. */
function workbookStream(sheets: BiffSheet[], pad = 0): Buffer {
  const strings: string[] = [];
  const sst = new Map<string, number>();
  let total = 0;
  for (const s of sheets) {
    for (const row of s.rows) {
      for (const v of row ?? []) {
        if (typeof v !== 'string') continue;
        total++;
        if (!sst.has(v)) {
          sst.set(v, strings.length);
          strings.push(v);
        }
      }
    }
  }
  const sstHead = Buffer.alloc(8);
  sstHead.writeUInt32LE(total, 0);
  sstHead.writeUInt32LE(strings.length, 4);
  const sstRecord = record(0x00fc, Buffer.concat([sstHead, ...strings.map((s) => xlString(s, 2))]));
  const streams = sheets.map((s) => sheetStream(s, sst));
  const boundsheet = (offset: number, name: string) => {
    const b = Buffer.alloc(6);
    b.writeUInt32LE(offset, 0);
    return record(0x0085, Buffer.concat([b, xlString(name, 1)]));
  };
  const head = [bof(0x0005), ...Array<Buffer>(pad).fill(WRITEACCESS), ...styles()];
  // Offsets depend on the globals' length, which does not depend on them.
  const globalsLength =
    Buffer.concat(head).length +
    sheets.reduce((n, s) => n + boundsheet(0, s.name).length, 0) +
    sstRecord.length +
    EOF.length;
  let at = globalsLength;
  const bounds = sheets.map((s, i) => {
    const r = boundsheet(at, s.name);
    at += streams[i]!.length;
    return r;
  });
  return Buffer.concat([...head, ...bounds, sstRecord, EOF, ...streams]);
}

const SECTOR = 512;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

function dirEntry(name: string, type: number, child: number, start: number, size: number): Buffer {
  const b = Buffer.alloc(128);
  if (type === 0) {
    b.writeUInt32LE(NOSTREAM, 68);
    b.writeUInt32LE(NOSTREAM, 72);
    b.writeUInt32LE(NOSTREAM, 76);
    return b;
  }
  const n = Buffer.from(`${name}\0`, 'utf16le');
  n.copy(b, 0);
  b.writeUInt16LE(n.length, 64);
  b.writeUInt8(type, 66);
  b.writeUInt8(1, 67); // black
  b.writeUInt32LE(NOSTREAM, 68);
  b.writeUInt32LE(NOSTREAM, 72);
  b.writeUInt32LE(child, 76);
  b.writeUInt32LE(start, 116);
  b.writeUInt32LE(size, 120);
  return b;
}

/** A `.xls` of the sheets: BIFF8 in a compound file, as Excel 97-2003 wrote. */
export function biffXls(sheets: BiffSheet[]): Buffer {
  let stream = workbookStream(sheets);
  if (stream.length < 4096) {
    stream = workbookStream(sheets, Math.ceil((4096 - stream.length) / WRITEACCESS.length));
  }
  const streamSectors = Math.ceil(stream.length / SECTOR);
  const fat = Buffer.alloc(SECTOR, 0xff);
  fat.writeUInt32LE(FATSECT, 0);
  fat.writeUInt32LE(ENDOFCHAIN, 4);
  for (let i = 0; i < streamSectors; i++) {
    fat.writeUInt32LE(i === streamSectors - 1 ? ENDOFCHAIN : 3 + i, (2 + i) * 4);
  }
  if (2 + streamSectors > SECTOR / 4)
    throw new Error('biffXls: workbook too large for one FAT sector');

  const header = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(0x0003, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44); // FAT sectors
  header.writeUInt32LE(1, 48); // first directory sector
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(ENDOFCHAIN, 60); // no mini FAT
  header.writeUInt32LE(ENDOFCHAIN, 68); // no DIFAT sectors
  header.writeUInt32LE(0, 76); // DIFAT[0]: the FAT is sector 0
  for (let i = 1; i < 109; i++) header.writeUInt32LE(FREESECT, 76 + i * 4);

  const dir = Buffer.concat([
    dirEntry('Root Entry', 5, 1, ENDOFCHAIN, 0),
    dirEntry('Workbook', 2, NOSTREAM, 2, stream.length),
    dirEntry('', 0, 0, 0, 0),
    dirEntry('', 0, 0, 0, 0),
  ]);
  const body = Buffer.alloc(streamSectors * SECTOR);
  stream.copy(body, 0);
  return Buffer.concat([header, fat, dir, body]);
}
