import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { thumbnailFor, thumbsRoot } from './thumbnail';
import { removeSpaceFile, spaceThumbsDir } from './space-disk';

// The render runs in the parser (POST /image/thumbnail); here its job
// function stands in for the exchange, a refused image answering null as
// the parser's `failed` does.
vi.mock('./parser-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./parser-client')>();
  const { thumbnailJpeg } = await import('./image-read');
  return {
    ...actual,
    parserThumbnail: (bytes: Buffer, mimeType: string, maxDim: number) =>
      thumbnailJpeg(bytes, mimeType === 'image/heic', maxDim).catch(() => null),
  };
});

/** Audit S9: a member's private image is thumbnailed inside its own space,
 *  keyed by node id, never in the brain's shared cache, and the thumbnail
 *  goes when the file is deleted. */
let tmp: string;
const prev = { files: process.env.MANTLE_FILES_ROOT, spaces: process.env.MANTLE_SPACES_ROOT };

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'space-thumbs-'));
  process.env.MANTLE_FILES_ROOT = path.join(tmp, 'files');
  process.env.MANTLE_SPACES_ROOT = path.join(tmp, 'spaces');
});

afterAll(async () => {
  for (const [k, v] of [
    ['MANTLE_FILES_ROOT', prev.files],
    ['MANTLE_SPACES_ROOT', prev.spaces],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('space thumbnails', () => {
  it('cache in the space folder by node id and go with the file', async () => {
    const { createCanvas } = await import('@napi-rs/canvas');
    const png = createCanvas(40, 40).toBuffer('image/png');
    const spaceId = randomUUID();
    const nodeId = randomUUID();
    const dir = spaceThumbsDir(spaceId);
    const out = await thumbnailFor({
      sha256: nodeId,
      cacheDir: dir,
      mimeType: 'image/png',
      loadBytes: async () => png,
    });
    expect(out).not.toBeNull();
    expect((await fs.readdir(dir)).some((f) => f.startsWith(`${nodeId}.`))).toBe(true);
    expect(existsSync(thumbsRoot())).toBe(false);
    await removeSpaceFile(spaceId, nodeId);
    expect((await fs.readdir(dir)).some((f) => f.startsWith(`${nodeId}.`))).toBe(false);
  });
});
