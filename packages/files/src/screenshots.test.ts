/**
 * The screenshot names: the PNG sniff (the signature, nothing less), the
 * picture's size from its IHDR header and the pixel caps, the filename
 * (UTC, to the second), and the shared tag and cap.
 */
import { describe, expect, it } from 'vitest';
import {
  isPngBytes,
  PNG_HEADER_BYTES,
  pngDimensions,
  screenshotFilename,
  screenshotTooLarge,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_PIXELS,
  SCREENSHOT_MAX_SIDE,
  SCREENSHOT_TAG,
} from './screenshots';
import { exportNames } from './export-home';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('isPngBytes', () => {
  it('a PNG: the eight-byte signature and anything after', () => {
    expect(isPngBytes(Buffer.from(PNG_HEAD))).toBe(true);
    expect(isPngBytes(Buffer.from([...PNG_HEAD, 0, 0, 0, 13]))).toBe(true);
    expect(isPngBytes(new Uint8Array([...PNG_HEAD, 1]))).toBe(true);
  });

  it('anything else, a short or a near miss too', () => {
    expect(isPngBytes(Buffer.alloc(0))).toBe(false);
    expect(isPngBytes(Buffer.from(PNG_HEAD.slice(0, 7)))).toBe(false);
    expect(isPngBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]))).toBe(false); // JPEG
    expect(isPngBytes(Buffer.from('GIF89a..'))).toBe(false);
    expect(isPngBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(false);
    // A text file that starts with "PNG" is no PNG.
    expect(isPngBytes(Buffer.from('PNG\r\n\x1a\n...'))).toBe(false);
    const flipped = [...PNG_HEAD];
    flipped[7] = 0x0b;
    expect(isPngBytes(Buffer.from(flipped))).toBe(false);
  });
});

/** The signature and an IHDR header saying `w` x `h`. */
const ihdr = (w: number, h: number, type = 'IHDR', len = 13) => {
  const b = Buffer.alloc(PNG_HEADER_BYTES);
  Buffer.from(PNG_HEAD).copy(b, 0);
  b.writeUInt32BE(len, 8);
  b.write(type, 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

describe('pngDimensions', () => {
  it("reads the width and height from the IHDR header, the PNG's first chunk", () => {
    expect(PNG_HEADER_BYTES).toBe(24);
    expect(pngDimensions(ihdr(1, 1))).toEqual({ width: 1, height: 1 });
    expect(pngDimensions(ihdr(2560, 1440))).toEqual({ width: 2560, height: 1440 });
    expect(pngDimensions(ihdr(0xffffffff, 7))).toEqual({ width: 0xffffffff, height: 7 });
    // At an offset in a larger buffer too (a Buffer from a pool).
    const pooled = Buffer.concat([Buffer.alloc(3), ihdr(640, 480)]).subarray(3);
    expect(pngDimensions(pooled)).toEqual({ width: 640, height: 480 });
  });

  it('null when it is no PNG or does not start with IHDR', () => {
    expect(pngDimensions(Buffer.from(PNG_HEAD))).toBeNull();
    expect(pngDimensions(ihdr(1, 1).subarray(0, 23))).toBeNull();
    expect(pngDimensions(ihdr(1, 1, 'IDAT'))).toBeNull();
    expect(pngDimensions(ihdr(1, 1, 'IHDR', 12))).toBeNull();
    expect(pngDimensions(ihdr(0, 1))).toBeNull();
    expect(pngDimensions(ihdr(1, 0))).toBeNull();
    const jpeg = Buffer.alloc(PNG_HEADER_BYTES, 0xff);
    expect(pngDimensions(jpeg)).toBeNull();
  });
});

describe('screenshotTooLarge', () => {
  it('16384 pixels a side and 64 megapixels at most', () => {
    expect(SCREENSHOT_MAX_SIDE).toBe(16_384);
    expect(SCREENSHOT_MAX_PIXELS).toBe(64_000_000);
    expect(screenshotTooLarge({ width: 16_384, height: 1 })).toBe(false);
    expect(screenshotTooLarge({ width: 1, height: 16_384 })).toBe(false);
    expect(screenshotTooLarge({ width: 8_000, height: 8_000 })).toBe(false);
    expect(screenshotTooLarge({ width: 16_385, height: 1 })).toBe(true);
    expect(screenshotTooLarge({ width: 1, height: 16_385 })).toBe(true);
    expect(screenshotTooLarge({ width: 8_000, height: 8_001 })).toBe(true);
    expect(screenshotTooLarge({ width: 0xffffffff, height: 0xffffffff })).toBe(true);
  });
});

describe('screenshotFilename', () => {
  it('screenshot-<yyyy-mm-dd-hhmmss>.png in UTC', () => {
    expect(screenshotFilename(new Date('2026-11-06T10:15:07.999Z'))).toBe(
      'screenshot-2026-11-06-101507.png',
    );
    expect(screenshotFilename(new Date('2026-01-02T23:59:59+02:00'))).toBe(
      'screenshot-2026-01-02-215959.png',
    );
  });

  it('is a name the export rule keeps as is, then -2 on a clash', () => {
    const name = screenshotFilename(new Date('2026-11-06T10:15:07Z'));
    const names = exportNames(name);
    expect(names[0]).toBe(name);
    expect(names[1]).toBe('screenshot-2026-11-06-101507-2.png');
  });
});

describe('the shared names', () => {
  it('the tag and the 10 MB cap', () => {
    expect(SCREENSHOT_TAG).toBe('screenshot');
    expect(SCREENSHOT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
