/**
 * How big a legacy workbook says its sheets are, read from the file's own
 * records before any reader lays a sheet out.
 *
 * anydoc renders a sheet as its full rectangle: a workbook holding A1 and a
 * cell 10,000 rows down and 200 across becomes 2,000,000 grid slots, built in
 * native memory and then as JavaScript objects (measured: 1.4 to 1.8 GB
 * resident for a sheet just under anydoc's own 4-million-slot limit). The
 * worker's heap limit does not cover the native half. So the extent each
 * sheet declares is read here first, from a few records, and a workbook
 * past the cell budget is refused before anydoc is called.
 *
 *  - `.xls` (BIFF8 in an OLE2 compound file): the Workbook stream's
 *    BOUNDSHEET records name the sheets and point at each sheet's BOF; the
 *    DIMENSIONS record after it holds the used range.
 *  - `.xlsb` (a zip of binary parts): each worksheet part starts with a
 *    BrtWsDim record holding the used range.
 *
 * A file whose extent cannot be read returns `null`: the reader then runs
 * under its own limits as before. The declared extent can lie; anydoc's own
 * slot limit is the backstop for a file that claims small and holds large.
 *
 * References: [MS-CFB] 2.2 to 2.6, [MS-XLS] 2.4.28 (BOUNDSHEET8) and
 * 2.4.90 (DIMENSIONS), [MS-XLSB] 2.1.4 (records) and 2.4.796 (BrtWsDim).
 */

import { loadZip } from './ooxml-media';

export type SheetExtent = { name: string; rows: number; cols: number };

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/** The named stream of a compound file, or null when it cannot be read. */
function cfbStream(buf: Buffer, wanted: string[]): Buffer | null {
  if (
    buf.length < 512 ||
    buf.readUInt32BE(0) !== 0xd0cf11e0 ||
    buf.readUInt32BE(4) !== 0xa1b11ae1
  ) {
    return null;
  }
  const sectorSize = 1 << buf.readUInt16LE(30);
  const miniSectorSize = 1 << buf.readUInt16LE(32);
  const numFat = buf.readUInt32LE(44);
  const firstDir = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const firstMiniFat = buf.readUInt32LE(60);
  let difatNext = buf.readUInt32LE(68);
  const sectors = Math.floor((buf.length - 512) / sectorSize);
  const sectorAt = (n: number) => 512 + n * sectorSize;
  if (sectorSize < 512 || numFat > sectors) return null;

  // The FAT's own sectors: 109 in the header, the rest in the DIFAT chain.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) {
    fatSectors.push(buf.readUInt32LE(76 + i * 4));
  }
  for (
    let guard = 0;
    fatSectors.length < numFat && difatNext < sectors && guard < sectors;
    guard++
  ) {
    const at = sectorAt(difatNext);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < numFat; i++) {
      fatSectors.push(buf.readUInt32LE(at + i * 4));
    }
    difatNext = buf.readUInt32LE(at + per * 4);
  }
  if (fatSectors.length < numFat || fatSectors.some((s) => s >= sectors)) return null;
  const fat = new Uint32Array(numFat * (sectorSize / 4));
  fatSectors.forEach((s, i) => {
    for (let j = 0; j < sectorSize / 4; j++)
      fat[i * (sectorSize / 4) + j] = buf.readUInt32LE(sectorAt(s) + j * 4);
  });

  /** A chain of sectors, read whole. Bounded by the sector count, so a
   *  looping chain ends. */
  const chain = (start: number, table: Uint32Array, read: (n: number) => Buffer): Buffer | null => {
    const parts: Buffer[] = [];
    let n = start;
    for (let guard = 0; n !== ENDOFCHAIN; guard++) {
      if (n >= table.length || guard > table.length || n === FREESECT) return null;
      parts.push(read(n));
      n = table[n]!;
    }
    return Buffer.concat(parts);
  };
  const readSector = (n: number) =>
    n < sectors ? buf.subarray(sectorAt(n), sectorAt(n) + sectorSize) : Buffer.alloc(0);

  const dir = chain(firstDir, fat, readSector);
  if (!dir) return null;
  type Entry = { name: string; type: number; start: number; size: number };
  const entries: Entry[] = [];
  for (let at = 0; at + 128 <= dir.length; at += 128) {
    const nameLen = Math.min(64, dir.readUInt16LE(at + 64));
    entries.push({
      name: dir.toString('utf16le', at, at + Math.max(0, nameLen - 2)),
      type: dir.readUInt8(at + 66),
      start: dir.readUInt32LE(at + 116),
      size: dir.readUInt32LE(at + 120),
    });
  }
  const root = entries[0];
  const entry = entries.find((e) => e.type === 2 && wanted.includes(e.name));
  if (!root || !entry) return null;
  if (entry.size >= miniCutoff) {
    return chain(entry.start, fat, readSector)?.subarray(0, entry.size) ?? null;
  }
  // A small stream lives in the mini stream (the root entry's own chain).
  const miniStream = chain(root.start, fat, readSector);
  const miniFatBytes = chain(firstMiniFat, fat, readSector);
  if (!miniStream || !miniFatBytes) return null;
  const miniFat = new Uint32Array(miniFatBytes.length / 4);
  for (let i = 0; i < miniFat.length; i++) miniFat[i] = miniFatBytes.readUInt32LE(i * 4);
  return (
    chain(entry.start, miniFat, (n) =>
      miniStream.subarray(n * miniSectorSize, (n + 1) * miniSectorSize),
    )?.subarray(0, entry.size) ?? null
  );
}

/** Sheet extents from a BIFF8 Workbook stream. */
function biffExtents(stream: Buffer): SheetExtent[] | null {
  const sheets: Array<{ name: string; offset: number }> = [];
  const extents = new Map<number, { rows: number; cols: number }>();
  let sheetStart = -1;
  for (let at = 0; at + 4 <= stream.length;) {
    const type = stream.readUInt16LE(at);
    const len = stream.readUInt16LE(at + 2);
    const body = at + 4;
    if (body + len > stream.length) break;
    if (type === 0x0085 && len >= 8) {
      // BOUNDSHEET8: offset of the sheet's BOF, flags, then a short string.
      const cch = stream.readUInt8(body + 6);
      const wide = (stream.readUInt8(body + 7) & 1) === 1;
      const name = wide
        ? stream.toString('utf16le', body + 8, Math.min(body + len, body + 8 + cch * 2))
        : stream.toString('latin1', body + 8, Math.min(body + len, body + 8 + cch));
      sheets.push({ name, offset: stream.readUInt32LE(body) });
    } else if (type === 0x0809 && len >= 4) {
      sheetStart = stream.readUInt16LE(body + 2) === 0x0010 ? at : -1;
    } else if (type === 0x0200 && len >= 14 && sheetStart >= 0 && !extents.has(sheetStart)) {
      const rows = Math.max(0, stream.readUInt32LE(body + 4) - stream.readUInt32LE(body));
      const cols = Math.max(0, stream.readUInt16LE(body + 10) - stream.readUInt16LE(body + 8));
      extents.set(sheetStart, { rows, cols });
    }
    at = body + len;
  }
  if (sheets.length === 0) return null;
  return sheets.map((s) => ({ name: s.name, ...(extents.get(s.offset) ?? { rows: 0, cols: 0 }) }));
}

/** One XLSB record header: a 1-2 byte type and a 1-4 byte size, 7 bits a
 *  byte, the high bit continuing. */
function xlsbRecord(b: Buffer, at: number): { type: number; size: number; body: number } | null {
  let type = 0;
  let i = at;
  for (let k = 0; k < 2; k++) {
    if (i >= b.length) return null;
    const byte = b[i++]!;
    type |= (byte & 0x7f) << (7 * k);
    if (!(byte & 0x80)) break;
  }
  let size = 0;
  for (let k = 0; k < 4; k++) {
    if (i >= b.length) return null;
    const byte = b[i++]!;
    size |= (byte & 0x7f) << (7 * k);
    if (!(byte & 0x80)) break;
  }
  return { type, size, body: i };
}

/** Parts past this are not opened to look for their extent; the read's own
 *  limits take them instead. */
const MAX_XLSB_PART_BYTES = 64 * 1024 * 1024;

async function xlsbExtents(bytes: Buffer): Promise<SheetExtent[] | null> {
  let zip;
  try {
    zip = await loadZip(bytes);
  } catch {
    return null;
  }
  const parts = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.bin$/i.test(p))
    .sort((a, b) => Number(/(\d+)\.bin$/i.exec(a)?.[1]) - Number(/(\d+)\.bin$/i.exec(b)?.[1]));
  if (parts.length === 0) return null;
  const out: SheetExtent[] = [];
  for (const [i, path] of parts.entries()) {
    const entry = zip.file(path)!;
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    if (typeof size === 'number' && size > MAX_XLSB_PART_BYTES) return null;
    const b = Buffer.from(await entry.async('uint8array'));
    // BrtWsDim comes in the sheet's first few records.
    for (let at = 0, n = 0; n < 32; n++) {
      const r = xlsbRecord(b, at);
      if (!r || r.body + r.size > b.length) break;
      if (r.type === 0x0094 && r.size >= 16) {
        const rows = b.readUInt32LE(r.body + 4) - b.readUInt32LE(r.body) + 1;
        const cols = b.readUInt32LE(r.body + 12) - b.readUInt32LE(r.body + 8) + 1;
        out.push({ name: `Sheet${i + 1}`, rows: Math.max(0, rows), cols: Math.max(0, cols) });
        break;
      }
      at = r.body + r.size;
    }
  }
  return out.length > 0 ? out : null;
}

/** The extent each sheet of a legacy workbook declares, or null when the
 *  file's records cannot be read (the reader's own limits then apply). */
export async function legacySheetExtents(bytes: Buffer): Promise<SheetExtent[] | null> {
  const stream = cfbStream(bytes, ['Workbook', 'Book']);
  if (stream) return biffExtents(stream);
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x504b0304) return xlsbExtents(bytes);
  return null;
}
