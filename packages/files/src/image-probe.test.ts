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

  it('returns null for containers it cannot render — EMF, junk', () => {
    // EMF record header: type 1, then a size field.
    const emf = Buffer.alloc(16);
    emf.writeUInt32LE(1, 0);
    expect(sniffImage(emf)).toBeNull();
    expect(sniffImage(Buffer.from('not an image at all'))).toBeNull();
    expect(sniffImage(Buffer.alloc(2))).toBeNull();
  });
});

describe('sniffImage — SVG', () => {
  it('reads absolute width/height off the root element', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="260"></svg>';
    expect(sniffImage(Buffer.from(svg))).toEqual({ ext: 'svg', width: 600, height: 260 });
  });

  it('accepts px units and single quotes', () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='640px' height='480px'/>";
    expect(sniffImage(Buffer.from(svg))).toEqual({ ext: 'svg', width: 640, height: 480 });
  });

  it('falls back to the viewBox when the size is fluid', () => {
    // A percentage width is the common authoring-tool output; the viewBox is
    // what actually describes the drawing's proportions.
    const svg = '<svg width="100%" height="100%" viewBox="0 0 800 450"></svg>';
    expect(sniffImage(Buffer.from(svg))).toEqual({ ext: 'svg', width: 800, height: 450 });
  });

  it('handles a comma-separated viewBox and a non-zero origin', () => {
    const svg = '<svg viewBox="10,20,300,150"></svg>';
    expect(sniffImage(Buffer.from(svg))).toEqual({ ext: 'svg', width: 300, height: 150 });
  });

  it('skips the XML prologue, doctype and comments', () => {
    const svg =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
      '<!-- exported by a drawing tool -->\n' +
      '<svg viewBox="0 0 400 400"></svg>';
    expect(sniffImage(Buffer.from(svg))).toEqual({ ext: 'svg', width: 400, height: 400 });
  });

  it('reports the type even when neither dimension source is present', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toEqual({
      ext: 'svg',
    });
  });

  it('does not mistake an HTML page containing an inline icon for an image', () => {
    const html = '<!DOCTYPE html><html><body><svg viewBox="0 0 16 16"></svg></body></html>';
    expect(sniffImage(Buffer.from(html))).toBeNull();
  });
});
