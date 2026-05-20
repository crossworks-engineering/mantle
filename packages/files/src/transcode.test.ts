import { describe, expect, it } from 'vitest';
import { isHeic, transcodeImageForVision } from './transcode';

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

  it('degrades gracefully to original bytes when HEIC decode fails', async () => {
    // Not valid HEIC — heic-convert will throw; the helper must catch and
    // return the original bytes/mime so the caller behaves as before.
    const bytes = Buffer.from('this is not a valid heic file');
    const out = await transcodeImageForVision(bytes, 'image/heic', 'fake.heic');
    expect(out.bytes).toBe(bytes);
    expect(out.mimeType).toBe('image/heic');
  });
});
