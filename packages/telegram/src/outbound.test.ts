import { describe, expect, it } from 'vitest';
import { mimeFromFilename, parseApprovalCallback, sniffImageMime } from './outbound';

describe('parseApprovalCallback', () => {
  const id = '11111111-2222-3333-4444-555555555555';

  it('parses an approve tap', () => {
    expect(parseApprovalCallback(`mantle:approve:${id}`)).toEqual({
      decision: 'approve',
      pendingId: id,
    });
  });

  it('parses a reject tap', () => {
    expect(parseApprovalCallback(`mantle:reject:${id}`)).toEqual({
      decision: 'reject',
      pendingId: id,
    });
  });

  it('rejects foreign / malformed callback data', () => {
    expect(parseApprovalCallback(undefined)).toBeNull();
    expect(parseApprovalCallback('')).toBeNull();
    expect(parseApprovalCallback('someoneelse:approve:' + id)).toBeNull(); // wrong prefix
    expect(parseApprovalCallback('mantle:delete:' + id)).toBeNull(); // wrong action
    expect(parseApprovalCallback('mantle:approve:')).toBeNull(); // empty id
    expect(parseApprovalCallback('mantle:approve')).toBeNull(); // missing segment
    expect(parseApprovalCallback(`mantle:approve:${id}:extra`)).toBeNull(); // trailing junk
  });
});

describe('mimeFromFilename', () => {
  it('maps Telegram photo extensions to image mimes', () => {
    expect(mimeFromFilename('file_42.jpg')).toBe('image/jpeg');
    expect(mimeFromFilename('photo.jpeg')).toBe('image/jpeg');
    expect(mimeFromFilename('shot.PNG')).toBe('image/png');
    expect(mimeFromFilename('sticker.webp')).toBe('image/webp');
    expect(mimeFromFilename('anim.gif')).toBe('image/gif');
  });

  it('still maps voice/audio extensions (no regression)', () => {
    expect(mimeFromFilename('voice.ogg')).toBe('audio/ogg');
    expect(mimeFromFilename('clip.opus')).toBe('audio/ogg');
    expect(mimeFromFilename('song.mp3')).toBe('audio/mpeg');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(mimeFromFilename('file')).toBe('application/octet-stream');
    expect(mimeFromFilename('data.bin')).toBe('application/octet-stream');
  });
});

describe('sniffImageMime', () => {
  const pad = (head: number[]) => Buffer.from([...head, ...new Array(12).fill(0)]);

  it('detects JPEG by magic bytes', () => {
    expect(sniffImageMime(pad([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
  });
  it('detects PNG by magic bytes', () => {
    expect(sniffImageMime(pad([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
  });
  it('detects GIF by magic bytes', () => {
    expect(sniffImageMime(pad([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
  });
  it('detects WEBP (RIFF....WEBP)', () => {
    const buf = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffImageMime(buf)).toBe('image/webp');
  });
  it('returns null for non-images and tiny buffers', () => {
    expect(sniffImageMime(pad([0x00, 0x01, 0x02]))).toBeNull();
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});
