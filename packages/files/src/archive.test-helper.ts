/**
 * Archives built in memory for the "Extract contents" tests
 * (archive-read.test.ts, the route's db test). Every archive here is
 * generated: no real file is read. The zip writer is hand-rolled (as in
 * bombs.test-helper.ts) so a test can write what no library writes: a name
 * that climbs (`../`), an absolute one, a symbolic link's mode, an
 * encrypted flag, a size that lies, a CRC that does not match, and a bomb
 * whose entry is far larger than memory (a repeated deflate block).
 */
import { constants, crc32, deflateRawSync, gzipSync } from 'node:zlib';

export type TestZipEntry = {
  name: string;
  /** The bytes; for a folder, leave it out and end the name with `/`. */
  data?: Buffer | string;
  /** The uncompressed content is `chunk` repeated `times` times (a bomb). */
  repeat?: { chunk: Buffer | string; times: number };
  store?: boolean;
  /** Written as the uncompressed size instead of the real one. */
  declaredSize?: number;
  /** A Unix mode (the maker is then Unix): 0o120777 is a symbolic link. */
  mode?: number;
  /** Set the encrypted flag (the data is left plain). */
  encrypted?: boolean;
  /** Write this CRC instead of the real one. */
  crc?: number;
};

/** A zip of the entries, in order (no zip64). */
export function testZip(entries: TestZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    let body: Buffer;
    let crc: number;
    let size: number;
    let method: number;
    if (e.repeat) {
      const chunk = Buffer.from(e.repeat.chunk);
      const flush = { level: 9, finishFlush: constants.Z_FULL_FLUSH };
      const block = deflateRawSync(chunk, flush);
      body = Buffer.concat([
        ...Array<Buffer>(e.repeat.times).fill(block),
        deflateRawSync(Buffer.alloc(0)),
      ]);
      crc = 0;
      for (let i = 0; i < e.repeat.times; i++) crc = crc32(chunk, crc);
      size = chunk.length * e.repeat.times;
      method = 8;
    } else {
      const data = Buffer.from(e.data ?? '');
      crc = crc32(data);
      size = data.length;
      method = e.store || data.length === 0 ? 0 : 8;
      body = method === 0 ? data : deflateRawSync(data);
    }
    if (e.declaredSize !== undefined) size = e.declaredSize;
    if (e.crc !== undefined) crc = e.crc;
    const flags = (e.encrypted ? 0x0001 : 0) | 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(Math.min(size, 0xffffffff), 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.mode !== undefined ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(Math.min(size, 0xffffffff), 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.mode !== undefined ? ((e.mode & 0xffff) << 16) >>> 0 : 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
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

export type TestTarEntry = {
  name: string;
  data?: Buffer | string;
  /** '0' a file (default), '5' a folder, '2' a symbolic link, '1' a hard
   *  link, '3' a character device. */
  type?: string;
  /** A header size other than the data's (the data is still written). */
  declaredSize?: number;
};

function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

const padTo512 = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

/** A TAR of the entries, in order. A name past 100 bytes gets a GNU long
 *  name block first. */
export function testTar(entries: TestTarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const type = e.type ?? '0';
    if (Buffer.byteLength(e.name) > 100) {
      const long = Buffer.from(`${e.name}\0`);
      parts.push(tarHeader('././@LongLink', long.length, 'L'), padTo512(long));
    }
    parts.push(tarHeader(e.name, e.declaredSize ?? data.length, type));
    if (data.length) parts.push(padTo512(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A gzip of the bytes. */
export function testGzip(bytes: Buffer | string): Buffer {
  return gzipSync(Buffer.from(bytes));
}
