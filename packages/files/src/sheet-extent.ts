/**
 * How big a legacy workbook's sheets really are, measured from their cell
 * records before any reader lays a sheet out, and the exact bytes the reader
 * is then given.
 *
 * anydoc renders a sheet as its full rectangle: a workbook holding A1 and a
 * cell 19,000 rows down and 200 across becomes 3.8 million grid slots, built
 * in native memory and then as JavaScript objects (measured: 1.5 GB resident
 * for one such sheet, 2.7 GB for two). The worker's heap limit does not
 * cover the native half. So each sheet's extent is measured here first and
 * a workbook past the cell budget is refused before anydoc is called.
 *
 * ## Measured from the cells, never from what the file declares
 *
 * A sheet's DIMENSIONS record (BrtWsDim in `.xlsb`) is the writer's claim
 * about its used range, and a 6 KB file can claim 1 x 1 and hold a cell at
 * row 19,000 column 200. anydoc ignores the claim and lays out the cells it
 * finds, so this reads the same records anydoc reads, the way it reads
 * them (its reader is open source; the record types, the framing, the
 * substream walk and the visibility rules below follow it), and takes each
 * sheet's extent as anydoc's grid assembly does: the bounding box of its
 * cells, widened by the merged ranges that touch it. Where this cannot be
 * exact it counts more, never less: every cell record counts, even one
 * whose text anydoc would drop as empty, and hidden rows and columns count.
 *
 * ## anydoc reads only what was measured
 *
 * A measurement is only as good as the agreement on what was measured. A
 * compound file or a zip can be read two ways (two streams named Workbook,
 * a sheet part reached by a relationship this reader resolves differently,
 * a corrupt FAT one reader repairs). So anydoc is never given the upload:
 * it is given a container rebuilt from the parts measured here.
 *
 *  - `.xls` (BIFF in an OLE2 compound file): the Workbook stream is read
 *    out and written into a fresh compound file holding that one stream.
 *    The globals' BOUNDSHEET records point at each sheet's BOF; each
 *    visible worksheet substream is walked from there to its EOF, nested
 *    substreams (an embedded chart) skipped, as anydoc walks it. Form
 *    checkboxes (an MSODRAWING shape anchor followed by a checkbox OBJ)
 *    are placed in the grid by anydoc, so their anchors count too.
 *  - `.xlsb` (a zip of binary record parts): the workbook part (found as
 *    anydoc finds it: the package relationship, else the conventional
 *    name) lists the visible sheets by relationship id; each is measured
 *    from its BrtRowHdr and cell records and its BrtMergeCell ranges. The
 *    rebuilt zip holds the workbook part, a relationships part written here
 *    that points each of those ids at a measured sheet and at nothing else,
 *    and the shared strings and styles. Nothing else goes in (VML drawings,
 *    so no checkboxes, which anydoc would otherwise place).
 *
 * A file whose sheets cannot be measured (not a compound file or a zip, no
 * Workbook stream, a workbook part that is XML, a record walk past anydoc's
 * own record budget) returns `null`: it is not given to anydoc at all.
 *
 * References: [MS-CFB] 2.2 to 2.6, [MS-XLS] 2.4 (records), [MS-XLSB] 2.1.4
 * (records) and 2.4 (record types), [MS-ODRAW] 2.2 (shape records).
 */

import JSZip from 'jszip';
import { loadZip, type Zip } from './zip-guard';

export type SheetExtent = { name: string; rows: number; cols: number };

/** A legacy workbook measured from its cells, and the rebuilt container
 *  holding exactly what was measured: what anydoc is given. */
export type MeasuredWorkbook = { extents: SheetExtent[]; bytes: Buffer };

/** anydoc's own record budget per workbook (its `MAX_RECORDS`): past it,
 *  anydoc fails the file, and so does the measurement. */
const MAX_RECORDS = 16_000_000;
/** anydoc's cap on one stream or part (its `MAX_ENTRY_BYTES`). */
const MAX_STREAM_BYTES = 128 * 1024 * 1024;

/** A rectangle of cells, zero-based and inclusive. */
type Box = { r1: number; c1: number; r2: number; c2: number };

/** The bounding box of `cells`, widened by each merge that touches it (one
 *  pass, as anydoc's grid assembly does), as rows x columns. */
class Extent {
  private box: Box | null = null;
  private readonly merges: Box[] = [];

  cell(r: number, c: number): void {
    const b = this.box;
    if (!b) this.box = { r1: r, c1: c, r2: r, c2: c };
    else {
      if (r < b.r1) b.r1 = r;
      if (r > b.r2) b.r2 = r;
      if (c < b.c1) b.c1 = c;
      if (c > b.c2) b.c2 = c;
    }
  }

  merge(m: Box): void {
    this.merges.push(m);
  }

  size(): { rows: number; cols: number } {
    const b = this.box;
    if (!b) return { rows: 0, cols: 0 };
    let { r1, c1, r2, c2 } = b;
    for (const m of this.merges) {
      if (m.r1 <= b.r2 && m.r2 >= b.r1 && m.c1 <= b.c2 && m.c2 >= b.c1) {
        r1 = Math.min(r1, m.r1);
        c1 = Math.min(c1, m.c1);
        r2 = Math.max(r2, m.r2);
        c2 = Math.max(c2, m.c2);
      }
    }
    return { rows: r2 - r1 + 1, cols: c2 - c1 + 1 };
  }
}

// ── The compound file ──────────────────────────────────────────────────

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

/** The Workbook (or BIFF5 Book) stream of a compound file, read whole, or
 *  null when the container cannot be read. */
function cfbWorkbookStream(buf: Buffer): Buffer | null {
  if (
    buf.length < 512 ||
    buf.readUInt32BE(0) !== 0xd0cf11e0 ||
    buf.readUInt32BE(4) !== 0xa1b11ae1
  ) {
    return null;
  }
  const shift = buf.readUInt16LE(30);
  if (shift !== 9 && shift !== 12) return null;
  const sectorSize = 1 << shift;
  const miniSectorSize = 1 << buf.readUInt16LE(32);
  const numFat = buf.readUInt32LE(44);
  const firstDir = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const firstMiniFat = buf.readUInt32LE(60);
  let difatNext = buf.readUInt32LE(68);
  // Sector n starts one sector in (the header occupies sector -1).
  const sectorAt = (n: number) => (n + 1) * sectorSize;
  // A last sector cut short reads as zero-padded, as the readers do.
  const sectors = Math.ceil((buf.length - sectorSize) / sectorSize);
  if (sectors <= 0 || numFat > sectors || miniSectorSize > sectorSize) return null;

  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) {
    fatSectors.push(buf.readUInt32LE(76 + i * 4));
  }
  const perDifat = sectorSize / 4 - 1;
  for (let guard = 0; fatSectors.length < numFat && guard < sectors; guard++) {
    if (difatNext >= sectors) return null;
    const at = sectorAt(difatNext);
    if (at + sectorSize > buf.length) return null;
    for (let i = 0; i < perDifat && fatSectors.length < numFat; i++) {
      fatSectors.push(buf.readUInt32LE(at + i * 4));
    }
    difatNext = buf.readUInt32LE(at + perDifat * 4);
  }
  if (fatSectors.length < numFat) return null;
  const perSector = sectorSize / 4;
  const fat = new Uint32Array(numFat * perSector);
  const readSector = (n: number): Buffer | null => {
    if (n >= sectors) return null;
    const at = sectorAt(n);
    if (at + sectorSize <= buf.length) return buf.subarray(at, at + sectorSize);
    const part = Buffer.alloc(sectorSize);
    buf.copy(part, 0, at);
    return part;
  };
  for (const [i, s] of fatSectors.entries()) {
    const sector = readSector(s);
    if (!sector) return null;
    for (let j = 0; j < perSector; j++) fat[i * perSector + j] = sector.readUInt32LE(j * 4);
  }

  /** A chain of `unit`-byte blocks, up to `want` bytes (all of it when
   *  undefined). A chain that loops or leaves the table is unreadable. */
  const chain = (
    start: number,
    table: Uint32Array,
    unit: number,
    block: (n: number) => Buffer | null,
    want?: number,
  ): Buffer | null => {
    const parts: Buffer[] = [];
    let got = 0;
    let n = start;
    for (let guard = 0; n !== ENDOFCHAIN; guard++) {
      if (want !== undefined && got >= want) break;
      if (n >= table.length || n === FREESECT || guard > table.length) return null;
      const b = block(n);
      if (!b) return null;
      parts.push(b);
      got += unit;
      n = table[n]!;
    }
    const all = Buffer.concat(parts);
    if (want !== undefined) return all.length >= want ? all.subarray(0, want) : null;
    return all;
  };
  const dir = chain(firstDir, fat, sectorSize, readSector);
  if (!dir || dir.length < 128) return null;
  type Entry = {
    name: string;
    type: number;
    left: number;
    right: number;
    child: number;
    start: number;
    size: number;
  };
  const entries: Entry[] = [];
  for (let at = 0; at + 128 <= dir.length; at += 128) {
    const nameLen = Math.min(64, dir.readUInt16LE(at + 64));
    entries.push({
      name: dir.toString('utf16le', at, at + Math.max(0, nameLen - 2)),
      type: dir.readUInt8(at + 66),
      left: dir.readUInt32LE(at + 68),
      right: dir.readUInt32LE(at + 72),
      child: dir.readUInt32LE(at + 76),
      start: dir.readUInt32LE(at + 116),
      // The high half of the size (version 4) must be zero for any stream
      // a reader would take.
      size:
        dir.readUInt32LE(at + 124) === 0 ? dir.readUInt32LE(at + 120) : Number.POSITIVE_INFINITY,
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) return null;

  // The root storage's own children (a red-black tree of siblings), where
  // anydoc looks for the stream; a stream inside a sub-storage is not it.
  const children: Entry[] = [];
  const seen = new Set<number>();
  const stack = [root.child];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === NOSTREAM || id >= entries.length || seen.has(id)) continue;
    seen.add(id);
    const e = entries[id]!;
    children.push(e);
    stack.push(e.left, e.right);
  }
  const named = (n: string) =>
    children.find((e) => e.type === 2 && e.name.toLowerCase() === n.toLowerCase());
  const entry = named('Workbook') ?? named('Book');
  if (!entry || !(entry.size <= MAX_STREAM_BYTES)) return null;
  if (entry.size === 0) return Buffer.alloc(0);

  if (entry.size >= miniCutoff) {
    return chain(entry.start, fat, sectorSize, readSector, entry.size);
  }
  // A small stream lives in the mini stream (the root entry's own chain).
  const miniStream = chain(root.start, fat, sectorSize, readSector);
  const miniFatBytes = chain(firstMiniFat, fat, sectorSize, readSector);
  if (!miniStream || !miniFatBytes) return null;
  const miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
  for (let i = 0; i < miniFat.length; i++) miniFat[i] = miniFatBytes.readUInt32LE(i * 4);
  return chain(
    entry.start,
    miniFat,
    miniSectorSize,
    (n) => {
      const at = n * miniSectorSize;
      return at + miniSectorSize <= miniStream.length
        ? miniStream.subarray(at, at + miniSectorSize)
        : null;
    },
    entry.size,
  );
}

/**
 * A compound file (version 4, 4,096-byte sectors) holding one stream,
 * `Workbook`. A stream under the 4,096-byte mini-stream cutoff is padded to
 * it with zero bytes, which no BIFF reader reaches: the globals and every
 * sheet end at their EOF record before it.
 */
export function compoundFileWithWorkbook(stream: Buffer): Buffer {
  const SECTOR = 4096;
  const data =
    stream.length >= SECTOR
      ? stream
      : Buffer.concat([stream, Buffer.alloc(SECTOR - stream.length)]);
  const streamSectors = Math.ceil(data.length / SECTOR);
  const perFat = SECTOR / 4;
  let fatSectors = 1;
  while (fatSectors * perFat < fatSectors + 1 + streamSectors) fatSectors++;
  if (fatSectors > 109) throw new Error('workbook stream too large to rebuild');
  const dirSector = fatSectors;
  const firstStream = fatSectors + 1;

  const header = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 24); // minor version
  header.writeUInt16LE(0x0004, 26); // major version 4
  header.writeUInt16LE(0xfffe, 28); // little-endian
  header.writeUInt16LE(12, 30); // 4,096-byte sectors
  header.writeUInt16LE(6, 32); // 64-byte mini sectors
  header.writeUInt32LE(1, 40); // directory sectors
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(dirSector, 48);
  header.writeUInt32LE(4096, 56); // mini-stream cutoff
  header.writeUInt32LE(ENDOFCHAIN, 60); // no mini FAT
  header.writeUInt32LE(0, 64);
  header.writeUInt32LE(ENDOFCHAIN, 68); // no DIFAT sectors
  header.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i < fatSectors ? i : FREESECT, 76 + i * 4);

  const fat = Buffer.alloc(fatSectors * SECTOR, 0xff);
  for (let i = 0; i < fatSectors; i++) fat.writeUInt32LE(FATSECT, i * 4);
  fat.writeUInt32LE(ENDOFCHAIN, dirSector * 4);
  for (let i = 0; i < streamSectors; i++) {
    const s = firstStream + i;
    fat.writeUInt32LE(i === streamSectors - 1 ? ENDOFCHAIN : s + 1, s * 4);
  }

  const entry = (name: string, type: number, child: number, start: number, size: number) => {
    const b = Buffer.alloc(128);
    b.writeUInt32LE(NOSTREAM, 68);
    b.writeUInt32LE(NOSTREAM, 72);
    b.writeUInt32LE(NOSTREAM, 76);
    if (type === 0) return b;
    const n = Buffer.from(`${name}\0`, 'utf16le');
    n.copy(b, 0);
    b.writeUInt16LE(n.length, 64);
    b.writeUInt8(type, 66);
    b.writeUInt8(1, 67); // black
    b.writeUInt32LE(child, 76);
    b.writeUInt32LE(start, 116);
    b.writeUInt32LE(size, 120);
    return b;
  };
  const dir = Buffer.alloc(SECTOR);
  entry('Root Entry', 5, 1, ENDOFCHAIN, 0).copy(dir, 0);
  entry('Workbook', 2, NOSTREAM, firstStream, data.length).copy(dir, 128);
  for (let at = 256; at < SECTOR; at += 128) entry('', 0, 0, 0, 0).copy(dir, at);

  const body = Buffer.alloc(streamSectors * SECTOR);
  data.copy(body, 0);
  return Buffer.concat([header, fat, dir, body]);
}

// ── BIFF: the .xls record stream ───────────────────────────────────────

const BOF = 0x0809;
const EOF_REC = 0x000a;
const FILEPASS = 0x002f;
const BOUNDSHEET = 0x0085;
const MERGEDCELLS = 0x00e5;
const LABELSST = 0x00fd;
const LABEL = 0x0204;
const RSTRING = 0x00d6;
const NUMBER = 0x0203;
const RK = 0x027e;
const MULRK = 0x00bd;
const BOOLERR = 0x0205;
const FORMULA = 0x0006;
const MSODRAWING = 0x00ec;
const OBJ = 0x005d;
const CONTINUE = 0x003c;
const WORKSHEET_SUBSTREAM = 0x0010;
/** The BIFF8 grid is 256 columns; anydoc drops a cell past it. */
const BIFF_MAX_COLS = 256;

/** One record's type and body, and where the next starts; null past the
 *  end (a truncated record ends the walk, as in anydoc). */
function biffRecord(
  data: Buffer,
  pos: number,
): { type: number; body: number; len: number; next: number } | null {
  if (pos + 4 > data.length) return null;
  const len = data.readUInt16LE(pos + 2);
  if (pos + 4 + len > data.length) return null;
  return { type: data.readUInt16LE(pos), body: pos + 4, len, next: pos + 4 + len };
}

/** The record budget shared by every walk of one workbook. */
class RecordBudget {
  used = 0;
  charge(): boolean {
    return ++this.used <= MAX_RECORDS;
  }
}

type BiffSheet = { name: string; offset: number; visible: boolean };

/** The globals substream: the sheets, and whether the file is encrypted.
 *  null when the stream does not open with a BOF. */
function biffGlobals(
  data: Buffer,
  budget: RecordBudget,
): { sheets: BiffSheet[]; biff8: boolean; encrypted: boolean } | null {
  const first = biffRecord(data, 0);
  if (!first || first.type !== BOF || first.len < 2) return null;
  const biff8 = data.readUInt16LE(first.body) === 0x0600;
  const sheets: BiffSheet[] = [];
  let depth = 1;
  for (let rec = biffRecord(data, first.next); rec; rec = biffRecord(data, rec.next)) {
    if (!budget.charge()) return null;
    if (rec.type === BOF) depth++;
    else if (rec.type === EOF_REC) {
      if (depth === 1) break;
      depth--;
    } else if (depth > 1) continue;
    else if (rec.type === FILEPASS) return { sheets, biff8, encrypted: true };
    else if (rec.type === BOUNDSHEET && rec.len >= 6) {
      // A VBA module (type 6) is not a sheet; the name is only for messages.
      if (data[rec.body + 5] === 0x06) continue;
      const state = data[rec.body + 4]! & 0x03;
      sheets.push({
        name: biffSheetName(data, rec.body + 6, rec.next, biff8) || `Sheet${sheets.length + 1}`,
        offset: data.readUInt32LE(rec.body),
        visible: state === 0,
      });
    }
  }
  return { sheets, biff8, encrypted: false };
}

/** A BOUNDSHEET name: BIFF8's short unicode string, or BIFF5's byte string. */
function biffSheetName(data: Buffer, at: number, end: number, biff8: boolean): string {
  if (at >= end) return '';
  const cch = data[at]!;
  if (!biff8) return data.toString('latin1', at + 1, Math.min(end, at + 1 + cch));
  if (at + 1 >= end) return '';
  const wide = (data[at + 1]! & 1) === 1;
  return wide
    ? data.toString('utf16le', at + 2, Math.min(end, at + 2 + cch * 2))
    : data.toString('latin1', at + 2, Math.min(end, at + 2 + cch));
}

/** The shape anchor anydoc keeps from one MSODRAWING body (its last
 *  shape's client anchor, and whether that shape is hidden), walked the way
 *  anydoc walks it: containers entered, so the walk stays linear. */
function lastShape(d: Buffer): { row: number; col: number; hidden: boolean } | null {
  const SP_CONTAINER = 0xf004;
  const OPT = 0xf00b;
  const CLIENT_ANCHOR = 0xf010;
  const PID_GROUP_SHAPE = 0x03bf;
  let anchor: { row: number; col: number } | null = null;
  let hidden = false;
  let off = 0;
  while (off + 8 <= d.length) {
    const verInst = d.readUInt16LE(off);
    const type = d.readUInt16LE(off + 2);
    const len = d.readUInt32LE(off + 4);
    if (off + 8 + len > d.length) break;
    if ((verInst & 0x000f) === 0x000f) {
      if (type === SP_CONTAINER) {
        anchor = null;
        hidden = false;
      }
      off += 8;
      continue;
    }
    const body = off + 8;
    if (type === CLIENT_ANCHOR && len >= 8) {
      anchor = { col: d.readUInt16LE(body + 2), row: d.readUInt16LE(body + 6) };
    } else if (type === OPT) {
      for (let i = 0; i < verInst >> 4; i++) {
        const at = body + i * 6;
        if (at + 6 > body + len) break;
        const pid = d.readUInt16LE(at);
        const op = d.readUInt32LE(at + 2);
        if ((pid & 0x3fff) === PID_GROUP_SHAPE && (op & 0x0002_0000) !== 0) {
          hidden = (op & 0x0000_0002) !== 0;
        }
      }
    }
    off = body + len;
  }
  return anchor ? { ...anchor, hidden } : null;
}

/** True when an OBJ record is a checkbox with a definite state, as anydoc
 *  decides it (a mixed state, 2, is not placed). */
function objIsCheckbox(data: Buffer, body: number, end: number): boolean {
  let off = body;
  let isCheckbox = false;
  let state: number | null = null;
  while (off + 4 <= end) {
    const ft = data.readUInt16LE(off);
    const cb = data.readUInt16LE(off + 2);
    if (ft === 0) break;
    if (off + 4 + cb > end) return false;
    if (ft === 0x0015 && cb >= 2) isCheckbox = data.readUInt16LE(off + 4) === 0x000b;
    if (ft === 0x0012 && cb >= 2) state = data.readUInt16LE(off + 4);
    off += 4 + cb;
  }
  return isCheckbox && (state === 0 || state === 1);
}

/** One worksheet substream's extent, walked from its BOF to its EOF as
 *  anydoc walks it. A substream that is not a worksheet (a chart or macro
 *  sheet) has none: anydoc does not read it. null past the record budget. */
function biffSheetExtent(
  data: Buffer,
  offset: number,
  biff8: boolean,
  budget: RecordBudget,
): Extent | null {
  const extent = new Extent();
  const first = biffRecord(data, offset);
  if (
    !first ||
    first.type !== BOF ||
    first.len < 4 ||
    data.readUInt16LE(first.body + 2) !== WORKSHEET_SUBSTREAM
  ) {
    return extent;
  }
  let depth = 1;
  let shape: { row: number; col: number; hidden: boolean } | null = null;
  for (let rec = biffRecord(data, first.next); rec; rec = biffRecord(data, rec.next)) {
    if (!budget.charge()) return null;
    const { type, body, len } = rec;
    if (type === BOF) {
      depth++;
      continue;
    }
    if (type === EOF_REC) {
      if (depth === 1) break;
      depth--;
      continue;
    }
    if (depth > 1) continue;
    switch (type) {
      case MERGEDCELLS: {
        const count = len >= 2 ? Math.min(data.readUInt16LE(body), Math.floor((len - 2) / 8)) : 0;
        for (let i = 0; i < count; i++) {
          const at = body + 2 + i * 8;
          const a = data.readUInt16LE(at);
          const b = data.readUInt16LE(at + 2);
          const c = data.readUInt16LE(at + 4);
          const d = data.readUInt16LE(at + 6);
          const r1 = Math.min(a, b);
          const r2 = Math.max(a, b);
          const c1 = Math.min(c, d);
          const c2 = Math.max(c, d);
          if (c1 >= BIFF_MAX_COLS || (r1 === r2 && c1 === c2)) continue;
          extent.merge({ r1, c1, r2, c2: Math.min(c2, BIFF_MAX_COLS - 1) });
        }
        break;
      }
      case LABELSST:
      case LABEL:
      case RSTRING:
      case NUMBER:
      case RK:
      case BOOLERR:
      case FORMULA: {
        if (len < 6) break;
        const col = data.readUInt16LE(body + 2);
        if (col < BIFF_MAX_COLS) extent.cell(data.readUInt16LE(body), col);
        break;
      }
      case MULRK: {
        if (len < 4) break;
        const row = data.readUInt16LE(body);
        const first = data.readUInt16LE(body + 2);
        const n = Math.floor(Math.max(0, len - 6) / 6);
        if (n === 0 || first >= BIFF_MAX_COLS) break;
        extent.cell(row, first);
        extent.cell(row, Math.min(first + n - 1, BIFF_MAX_COLS - 1));
        break;
      }
      case MSODRAWING: {
        if (!biff8) break;
        // The body and the CONTINUE records after it, as one drawing.
        const segs = [data.subarray(body, body + len)];
        for (
          let c = biffRecord(data, rec.next);
          c && c.type === CONTINUE;
          c = biffRecord(data, c.next)
        ) {
          segs.push(data.subarray(c.body, c.next));
        }
        shape = lastShape(segs.length === 1 ? segs[0]! : Buffer.concat(segs));
        break;
      }
      case OBJ: {
        if (!biff8) break;
        if (objIsCheckbox(data, body, body + len)) {
          const s = shape;
          shape = null;
          if (s && !s.hidden && s.col < BIFF_MAX_COLS) extent.cell(s.row, s.col);
        }
        break;
      }
    }
  }
  return extent;
}

/** A BIFF workbook measured, rebuilt into a fresh compound file. */
function measureXls(bytes: Buffer): MeasuredWorkbook | null {
  const stream = cfbWorkbookStream(bytes);
  if (!stream) return null;
  const budget = new RecordBudget();
  const globals = biffGlobals(stream, budget);
  if (!globals) return null;
  // Encrypted: anydoc stops at FILEPASS before any sheet, so nothing is laid
  // out; it reads the rebuilt file and reports it as encrypted.
  const extents: SheetExtent[] = [];
  if (!globals.encrypted) {
    for (const sheet of globals.sheets) {
      if (!sheet.visible) continue;
      const extent = biffSheetExtent(stream, sheet.offset, globals.biff8, budget);
      if (!extent) return null;
      extents.push({ name: sheet.name, ...extent.size() });
    }
  }
  return { extents, bytes: compoundFileWithWorkbook(stream) };
}

// ── XLSB: the binary SpreadsheetML zip ─────────────────────────────────

const BRT_ROW_HDR = 0;
const BRT_CELL_TYPES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 62]);
const BRT_BUNDLE_SH = 156;
const BRT_MERGE_CELL = 176;
const XLSX_MAX_ROWS = 1_048_576;
const XLSX_MAX_COLS = 16_384;

const REL_OFFICE_DOCUMENT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const REL_WORKSHEET =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const REL_SHARED_STRINGS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings';
const REL_STYLES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';

/** One XLSB record stream, record by record (a 1-2 byte type and a 1-4 byte
 *  size, 7 bits a byte), stopping at the first framing fault, where
 *  anydoc's reader stops too. */
function* xlsbRecords(
  b: Uint8Array,
  budget: RecordBudget,
): Generator<{ type: number; body: number; size: number }, boolean> {
  let at = 0;
  while (at < b.length) {
    if (!budget.charge()) return false;
    const b0 = b[at++]!;
    let type = b0;
    if (b0 & 0x80) {
      if (at >= b.length) return true;
      type = (b0 & 0x7f) | ((b[at++]! & 0x7f) << 7);
    }
    let size = 0;
    for (let i = 0; ; i++) {
      if (at >= b.length) return true;
      const byte = b[at++]!;
      size += (byte & 0x7f) * 2 ** (7 * i);
      if (!(byte & 0x80)) break;
      if (i === 3) return true;
    }
    if (at + size > b.length) return true;
    yield { type, body: at, size };
    at += size;
  }
  return true;
}

const u32 = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000;

/** An XLWideString at `at` (a u32 count of UTF-16 units), or null when it
 *  runs past `end`; returns the string and where it ends. */
function wideString(b: Uint8Array, at: number, end: number): { s: string; next: number } | null {
  if (at + 4 > end) return null;
  const cch = u32(b, at);
  const bytes = cch * 2;
  if (at + 4 + bytes > end) return null;
  return {
    s: Buffer.from(b.buffer, b.byteOffset + at + 4, bytes).toString('utf16le'),
    next: at + 4 + bytes,
  };
}

/** The visible sheets of `xl/workbook.bin`: name and relationship id, in
 *  order (BrtBundleSh), or null when a record does not parse (anydoc then
 *  fails the file). */
function xlsbBundles(
  wb: Uint8Array,
  budget: RecordBudget,
): Array<{ name: string; rid: string }> | null {
  const out: Array<{ name: string; rid: string }> = [];
  const records = xlsbRecords(wb, budget);
  for (let r = records.next(); !r.done; r = records.next()) {
    const { type, body, size } = r.value;
    if (type !== BRT_BUNDLE_SH) continue;
    const end = body + size;
    if (body + 8 > end) return null;
    const state = u32(wb, body);
    let at = body + 8;
    let rid: string | null = null;
    if (at + 4 <= end && u32(wb, at) === 0xffffffff) at += 4;
    else {
      const s = wideString(wb, at, end);
      if (!s) return null;
      rid = s.s;
      at = s.next;
    }
    const name = wideString(wb, at, end);
    if (!name) return null;
    if (state === 1 || state === 2 || rid === null) continue;
    out.push({ name: name.s, rid });
  }
  // A walk stopped by the record budget: anydoc fails the file.
  return budget.used > MAX_RECORDS ? null : out;
}

/** One sheet part's extent: cells as anydoc places them (a row from the
 *  BrtRowHdr before them, a column from the cell header), merged ranges,
 *  up to the first framing fault. null past the record budget. */
function xlsbSheetExtent(b: Uint8Array, budget: RecordBudget): Extent | null {
  const extent = new Extent();
  let row: number | null = null;
  const records = xlsbRecords(b, budget);
  let r = records.next();
  for (; !r.done; r = records.next()) {
    const { type, body, size } = r.value;
    if (type === BRT_ROW_HDR) {
      if (size < 4) break;
      const rw = u32(b, body);
      row = rw < XLSX_MAX_ROWS ? rw : null;
    } else if (type === BRT_MERGE_CELL) {
      if (size < 16) break;
      const r1 = u32(b, body);
      const r2 = u32(b, body + 4);
      const c1 = u32(b, body + 8);
      const c2 = u32(b, body + 12);
      if (Math.max(r1, r2) >= XLSX_MAX_ROWS || Math.max(c1, c2) >= XLSX_MAX_COLS) continue;
      if (r1 !== r2 || c1 !== c2) {
        extent.merge({
          r1: Math.min(r1, r2),
          c1: Math.min(c1, c2),
          r2: Math.max(r1, r2),
          c2: Math.max(c1, c2),
        });
      }
    } else if (BRT_CELL_TYPES.has(type)) {
      if (size < 8) break;
      const col = u32(b, body);
      if (row !== null && col < XLSX_MAX_COLS) extent.cell(row, col);
    }
  }
  if (r.done && r.value === false) return null;
  return extent;
}

/** `Target` resolved against the part that declared it, as OPC does: an
 *  absolute target from the package root, `..` collapsing. */
function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const segments = base.split('/').slice(0, -1);
  for (const s of target.split('/')) {
    if (s === '.' || s === '') continue;
    if (s === '..') segments.pop();
    else segments.push(s);
  }
  return segments.join('/');
}

type Rel = { id: string; type: string; target: string; external: boolean };

/** A relationships part, its `<Relationship>` elements by id. */
async function readRels(zip: Zip, path: string): Promise<Map<string, Rel>> {
  const out = new Map<string, Rel>();
  const xml = await zip.file(path)?.async('string');
  if (!xml) return out;
  const { tagsNamed } = await import('./xml-scan');
  const attr = (tag: string, name: string) =>
    new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`)
      .exec(tag)
      ?.slice(1)
      .find((v) => v != null);
  for (const tag of tagsNamed(xml, (n) => n === 'Relationship')) {
    const id = attr(tag, 'Id');
    if (!id) continue;
    out.set(id, {
      id,
      type: attr(tag, 'Type') ?? '',
      target: attr(tag, 'Target') ?? '',
      external: attr(tag, 'TargetMode') === 'External',
    });
  }
  return out;
}

/** The relationship of `type` with the lowest id, as anydoc picks one. */
function firstOfType(rels: Map<string, Rel>, type: string): Rel | undefined {
  return [...rels.values()]
    .filter((r) => r.type === type && !r.external)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

function relsPathFor(part: string): string {
  const at = part.lastIndexOf('/');
  return at === -1 ? `_rels/${part}.rels` : `${part.slice(0, at)}/_rels/${part.slice(at + 1)}.rels`;
}

const xmlAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** An `.xlsb` measured, rebuilt into a fresh zip of exactly those parts. */
async function measureXlsb(bytes: Buffer): Promise<MeasuredWorkbook | null> {
  let zip: Zip;
  try {
    zip = await loadZip(bytes);
  } catch (err) {
    const { isDocumentLimitError } = await import('./document-limit');
    if (isDocumentLimitError(err)) throw err;
    return null;
  }
  const pkgRels = await readRels(zip, '_rels/.rels');
  const main = firstOfType(pkgRels, REL_OFFICE_DOCUMENT);
  const wbPath = main
    ? resolvePart('', main.target)
    : ['xl/workbook.xml', 'xl/workbook.bin'].find((p) => zip.file(p));
  if (!wbPath) return null;
  const wbFile = zip.file(wbPath);
  if (!wbFile) return null;
  const wb = Buffer.from(await wbFile.async('uint8array'));
  // An XML workbook part is not an .xlsb; this reader does not measure it.
  let lead = 0;
  if (wb[0] === 0xef && wb[1] === 0xbb && wb[2] === 0xbf) lead = 3;
  while (lead < wb.length && /\s/.test(String.fromCharCode(wb[lead]!))) lead++;
  if (lead >= wb.length || wb[lead] === 0x3c || wb[lead] === 0xff || wb[lead] === 0xfe) return null;

  const budget = new RecordBudget();
  const bundles = xlsbBundles(wb, budget);
  if (!bundles) return null;
  const wbRels = await readRels(zip, relsPathFor(wbPath));

  const out = new JSZip();
  const sheetFor = new Map<string, string>(); // source part -> rebuilt part
  const relLines: string[] = [];
  const extents: SheetExtent[] = [];
  const measured = new Map<string, { rows: number; cols: number }>();
  const ridsWritten = new Set<string>();
  for (const { name, rid } of bundles) {
    const rel = wbRels.get(rid);
    if (!rel || rel.external) continue;
    const source = resolvePart(wbPath, rel.target);
    const file = zip.file(source);
    if (!file) continue;
    let size = measured.get(source);
    if (!size) {
      const part = await file.async('uint8array');
      const extent = xlsbSheetExtent(part, budget);
      if (!extent) return null;
      size = extent.size();
      measured.set(source, size);
      const target = `worksheets/sheet${sheetFor.size + 1}.bin`;
      sheetFor.set(source, target);
      out.file(`xl/${target}`, part);
    }
    extents.push({ name, ...size });
    if (!ridsWritten.has(rid)) {
      ridsWritten.add(rid);
      relLines.push(
        `<Relationship Id="${xmlAttr(rid)}" Type="${REL_WORKSHEET}" Target="${sheetFor.get(source)}"/>`,
      );
    }
  }

  // Shared strings and styles where anydoc would look for them, under ids no
  // sheet uses, so no sheet can be pointed at them.
  const freshId = (base: string) => {
    let id = base;
    for (let i = 1; ridsWritten.has(id); i++) id = `${base}${i}`;
    ridsWritten.add(id);
    return id;
  };
  const sibling = (type: string, conventional: string) => {
    const r = firstOfType(wbRels, type);
    if (r) return resolvePart(wbPath, r.target);
    const at = wbPath.lastIndexOf('/');
    return at === -1 ? conventional : `${wbPath.slice(0, at)}/${conventional}`;
  };
  for (const [type, conventional, rebuilt] of [
    [REL_SHARED_STRINGS, 'sharedStrings.bin', 'sharedStrings.bin'],
    [REL_STYLES, 'styles.bin', 'styles.bin'],
  ] as const) {
    const file = zip.file(sibling(type, conventional));
    if (!file) continue;
    out.file(`xl/${rebuilt}`, await file.async('uint8array'));
    relLines.push(
      `<Relationship Id="${freshId(`mantle${rebuilt.replace('.bin', '')}`)}" Type="${type}" Target="${rebuilt}"/>`,
    );
  }

  const rels = (lines: string[]) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${lines.join('')}</Relationships>`;
  out.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
  );
  out.file(
    '_rels/.rels',
    rels([`<Relationship Id="rId1" Type="${REL_OFFICE_DOCUMENT}" Target="xl/workbook.bin"/>`]),
  );
  out.file('xl/workbook.bin', wb);
  out.file('xl/_rels/workbook.bin.rels', rels(relLines));
  const rebuilt = await out.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  return { extents, bytes: rebuilt };
}

/**
 * Each visible sheet's extent, measured from its cell records, and the
 * container anydoc is to read instead of the upload (see the module note);
 * null when the file's sheets cannot be measured, in which case anydoc
 * must not read it at all. Throws a DocumentLimitError for a zip past its
 * inflate caps (./zip-guard.ts).
 */
export async function measureLegacyWorkbook(bytes: Buffer): Promise<MeasuredWorkbook | null> {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xd0cf11e0) return measureXls(bytes);
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x504b0304) return measureXlsb(bytes);
  return null;
}
