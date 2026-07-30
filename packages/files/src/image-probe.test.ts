import { describe, expect, it } from 'vitest';
import { sniffImage } from './image-probe';

/** Minimal but structurally valid headers — the prober only ever reads the
 *  first few bytes, so building real encoded images would test nothing extra
 *  while making the failures harder to read. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpegHeader(width: number, height: number): Buffer {
  // SOI, a JFIF APP0 we expect to be skipped, then an SOF0 frame header.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(0x0008, 2); // segment length
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe('sniffImage', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(sniffImage(pngHeader(600, 260))).toEqual({ ext: 'png', width: 600, height: 260 });
  });

  it('walks JPEG segments to the frame header', () => {
    expect(sniffImage(jpegHeader(1024, 768))).toEqual({ ext: 'jpg', width: 1024, height: 768 });
  });

  it('does not mistake a Huffman table for a frame header', () => {
    // 0xFFC4 (DHT) sits in the same C0-CF range as the SOF markers but is not
    // a frame — reading dimensions from it yields garbage.
    const dht = Buffer.alloc(11);
    dht.writeUInt16BE(0xffc4, 0);
    dht.writeUInt16BE(0x0008, 2);
    dht.writeUInt16BE(9999, 5);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8]), dht, jpegHeader(320, 200).subarray(2)]);
    expect(sniffImage(bytes)).toEqual({ ext: 'jpg', width: 320, height: 200 });
  });

  it('reads GIF dimensions little-endian', () => {
    const b = Buffer.alloc(10);
    b.write('GIF89a', 0, 'latin1');
    b.writeUInt16LE(48, 6);
    b.writeUInt16LE(64, 8);
    expect(sniffImage(b)).toEqual({ ext: 'gif', width: 48, height: 64 });
  });

  it('reads an extended (VP8X) WebP canvas, which stores size minus one', () => {
    const b = Buffer.alloc(30);
    b.write('RIFF', 0, 'latin1');
    b.write('WEBP', 8, 'latin1');
    b.write('VP8X', 12, 'latin1');
    b.writeUIntLE(639, 24, 3); // 640 - 1
    b.writeUIntLE(479, 27, 3); // 480 - 1
    expect(sniffImage(b)).toEqual({ ext: 'webp', width: 640, height: 480 });
  });

  it('takes the magnitude of a top-down BMP height', () => {
    const b = Buffer.alloc(26);
    b.write('BM', 0, 'latin1');
    b.writeInt32LE(200, 18);
    b.writeInt32LE(-100, 22); // negative = top-down row order
    expect(sniffImage(b)).toEqual({ ext: 'bmp', width: 200, height: 100 });
  });

  it('returns null for containers it cannot render — EMF, SVG, junk', () => {
    // EMF record header: type 1, then a size field.
    const emf = Buffer.alloc(16);
    emf.writeUInt32LE(1, 0);
    expect(sniffImage(emf)).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.from('not an image at all'))).toBeNull();
    expect(sniffImage(Buffer.alloc(2))).toBeNull();
  });
});
