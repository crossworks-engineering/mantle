/**
 * embeddableJpeg reads the picture's own header before it decodes
 * anything (embed-image.ts): a small file that declares a huge picture (a
 * decompression bomb) is refused without allocating its pixels, as is one
 * whose header cannot be read or is not a PNG, JPEG or WebP. A real small
 * picture still embeds. All bytes are made up.
 */
import { describe, expect, it, vi } from 'vitest';

const decoded = vi.hoisted(() => ({ n: 0 }));
vi.mock('@napi-rs/canvas', async (importOriginal) => {
  const real = await importOriginal<typeof import('@napi-rs/canvas')>();
  return {
    ...real,
    loadImage: (...args: Parameters<typeof real.loadImage>) => {
      decoded.n += 1;
      return real.loadImage(...args);
    },
  };
});

import { embeddableJpeg, headerWithinPixels } from './embed-image';

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const MAX = 25_000_000;
const opts = { maxBytes: 200_000, maxSourceBytes: 12 * 1024 * 1024 };

/** The 1x1 PNG with its IHDR declaring `w` x `h`. */
function pngOf(w: number, h: number): Buffer {
  const b = Buffer.from(PNG);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
/** A JPEG that is only a frame header declaring `w` x `h`. */
function jpegOf(w: number, h: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03]);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(16)]);
}
/** A lossless WebP header declaring `w` x `h`. */
function webpOf(w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8L', 12, 'latin1');
  b[20] = 0x2f;
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  return b;
}

describe('the header is read before anything is decoded', () => {
  it('reads each container: within the cap, past it, unreadable', () => {
    expect(headerWithinPixels(PNG, MAX)).toBe(true);
    expect(headerWithinPixels(pngOf(5000, 5000), MAX)).toBe(true);
    expect(headerWithinPixels(pngOf(5001, 5000), MAX)).toBe(false);
    expect(headerWithinPixels(pngOf(100_000, 100_000), MAX)).toBe(false);
    expect(headerWithinPixels(jpegOf(4000, 3000), MAX)).toBe(true);
    expect(headerWithinPixels(jpegOf(65_000, 65_000), MAX)).toBe(false);
    expect(headerWithinPixels(webpOf(16_000, 16_000), MAX)).toBe(false);
    expect(headerWithinPixels(webpOf(800, 600), MAX)).toBe(true);
    // No size in it, a zero edge, or not a picture the decoder may take.
    expect(headerWithinPixels(PNG.subarray(0, 20), MAX)).toBe(false);
    expect(headerWithinPixels(pngOf(0, 10), MAX)).toBe(false);
    expect(headerWithinPixels(Buffer.from('GIF89a\x10\x00\x10\x00', 'latin1'), MAX)).toBe(false);
    expect(headerWithinPixels(Buffer.from('<svg width="10" height="10"/>'), MAX)).toBe(false);
  });

  it('a bomb is refused with nothing decoded; a real crop still embeds', async () => {
    decoded.n = 0;
    expect(await embeddableJpeg(pngOf(100_000, 100_000), 'image/png', opts)).toBeNull();
    expect(await embeddableJpeg(jpegOf(65_000, 65_000), 'image/jpeg', opts)).toBeNull();
    // A stated type the bytes do not bear out is refused too (the decoder
    // reads the bytes).
    expect(
      await embeddableJpeg(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'image/png', opts),
    ).toBeNull();
    expect(decoded.n).toBe(0);
    const out = await embeddableJpeg(PNG, 'image/png', opts);
    expect(out?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(decoded.n).toBe(1);
  });
});
