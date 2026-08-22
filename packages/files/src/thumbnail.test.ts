import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isThumbable, thumbnailFor, deleteThumbnailsFor, thumbsRoot } from './thumbnail';

/**
 * Real renders against a temp root — @napi-rs/canvas is a direct dep, so the
 * whole pipeline (decode → scale → JPEG → disk cache) runs in-process without
 * a database or a server. The cache-hit case is proven by making the second
 * call's loadBytes explode: if it still answers, the bytes came from disk.
 */
let tmpRoot: string;
let prevFilesRoot: string | undefined;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-test-'));
  prevFilesRoot = process.env.MANTLE_FILES_ROOT;
  process.env.MANTLE_FILES_ROOT = path.join(tmpRoot, 'files');
});

afterAll(async () => {
  if (prevFilesRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
  else process.env.MANTLE_FILES_ROOT = prevFilesRoot;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function testPng(width: number, height: number): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, width, height);
  return c.toBuffer('image/png');
}

describe('isThumbable', () => {
  it('accepts raster images, with charset noise tolerated', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/webp', 'IMAGE/PNG; charset=binary']) {
      expect(isThumbable(m), m).toBe(true);
    }
  });

  it('refuses svg (scales in the browser), gif (animation), and non-images', () => {
    for (const m of ['image/svg+xml', 'image/gif', 'application/pdf', 'video/mp4', '']) {
      expect(isThumbable(m), m).toBe(false);
    }
  });
});

describe('thumbnailFor', () => {
  it('renders, bounds the long edge, and caches to disk', async () => {
    const png = await testPng(1600, 800);
    const out = await thumbnailFor({
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
      loadBytes: async () => png,
    });
    expect(out).not.toBeNull();
    // JPEG magic — the derivative is a real encode, not the input passed back.
    expect(out![0]).toBe(0xff);
    expect(out![1]).toBe(0xd8);
    const cached = await fs.readdir(thumbsRoot());
    expect(cached.some((f) => f.startsWith('a'.repeat(64)))).toBe(true);

    // Second call: loadBytes exploding proves the answer came from the cache.
    const again = await thumbnailFor({
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
      loadBytes: async () => {
        throw new Error('must not load original on a cache hit');
      },
    });
    expect(again).not.toBeNull();
    expect(again!.equals(out!)).toBe(true);
  });

  it('does not upscale a small image', async () => {
    const png = await testPng(64, 64);
    const out = await thumbnailFor({
      sha256: 'b'.repeat(64),
      mimeType: 'image/png',
      loadBytes: async () => png,
    });
    expect(out).not.toBeNull();
    const { loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(out!);
    expect(img.width).toBe(64);
    expect(img.height).toBe(64);
  });

  it('answers null (never throws) for unsupported and broken input', async () => {
    expect(
      await thumbnailFor({
        sha256: 'c'.repeat(64),
        mimeType: 'application/pdf',
        loadBytes: async () => Buffer.from('x'),
      }),
    ).toBeNull();
    expect(
      await thumbnailFor({
        sha256: 'd'.repeat(64),
        mimeType: 'image/png',
        loadBytes: async () => Buffer.from('not a png at all'),
      }),
    ).toBeNull();
    expect(
      await thumbnailFor({
        sha256: 'e'.repeat(64),
        mimeType: 'image/png',
        loadBytes: async () => null,
      }),
    ).toBeNull();
  });
});

describe('deleteThumbnailsFor', () => {
  it('removes every dimension for a hash and tolerates absence', async () => {
    await deleteThumbnailsFor('a'.repeat(64));
    const left = await fs.readdir(thumbsRoot());
    expect(left.some((f) => f.startsWith('a'.repeat(64)))).toBe(false);
    await deleteThumbnailsFor(null); // no-op, must not throw
    await deleteThumbnailsFor('f'.repeat(64)); // nothing there, must not throw
  });
});
