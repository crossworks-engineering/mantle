import { describe, expect, it, vi } from 'vitest';
import { ParserError } from './parser-client';
import { isHeic, transcodeImageForVision } from './transcode';

const h = vi.hoisted(() => ({ fail: null as null | (() => Error) }));
vi.mock('./parser-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./parser-client')>();
  return {
    ...actual,
    parserImageForVision: async (bytes: Buffer) => {
      if (h.fail) throw h.fail();
      return { bytes: Buffer.concat([Buffer.from('jpeg:'), bytes]), mimeType: 'image/jpeg' };
    },
  };
});

describe('isHeic', () => {
  it('detects HEIC/HEIF by MIME type', () => {
    expect(isHeic('image/heic')).toBe(true);
    expect(isHeic('image/heif')).toBe(true);
    expect(isHeic('image/HEIC')).toBe(true);
  });

  it('detects HEIC/HEIF by filename extension', () => {
    expect(isHeic(null, 'IMG_1234.HEIC')).toBe(true);
    expect(isHeic('application/octet-stream', 'photo.heif')).toBe(true);
  });

  it('returns false for normal raster formats', () => {
    expect(isHeic('image/jpeg', 'photo.jpg')).toBe(false);
    expect(isHeic('image/png')).toBe(false);
    expect(isHeic(undefined, 'notes.txt')).toBe(false);
    expect(isHeic(null, null)).toBe(false);
  });
});

describe('transcodeImageForVision', () => {
  it('passes non-HEIC bytes through untouched (no decode, same buffer + mime)', async () => {
    const bytes = Buffer.from('not really an image, but not heic either');
    const out = await transcodeImageForVision(bytes, 'image/jpeg', 'photo.jpg');
    expect(out.mimeType).toBe('image/jpeg');
    expect(out.bytes).toBe(bytes); // same reference — proves no transcode ran
  });

  it('sends HEIC to the parser and returns its JPEG', async () => {
    h.fail = null;
    const out = await transcodeImageForVision(Buffer.from('heic'), 'image/heic', 'a.heic');
    expect(out).toEqual({ bytes: Buffer.from('jpeg:heic'), mimeType: 'image/jpeg' });
  });

  it('degrades to the original bytes when the parser refuses the image (a verdict)', async () => {
    // A corrupt HEIC: the caller behaves as before (the vision call may then
    // fail, handled upstream).
    h.fail = () => new ParserError('failed', 'not a HEIC', { retryable: false, terminal: false });
    const bytes = Buffer.from('this is not a valid heic file');
    const out = await transcodeImageForVision(bytes, 'image/heic', 'fake.heic');
    expect(out.bytes).toBe(bytes);
    expect(out.mimeType).toBe('image/heic');
  });

  it('throws a retryable parser failure: an unconverted HEIC is never sent on to vision', async () => {
    for (const code of ['busy', 'unavailable', 'timeout'] as const) {
      h.fail = () => new ParserError(code, code, { retryable: true, terminal: false });
      await expect(
        transcodeImageForVision(Buffer.from('heic'), 'image/heic', 'a.heic'),
      ).rejects.toMatchObject({ code, retryable: true });
    }
    h.fail = null;
  });
});
