/**
 * The screenshot names: the PNG sniff (the signature, nothing less), the
 * filename (UTC, to the second), and the shared tag and cap.
 */
import { describe, expect, it } from 'vitest';
import {
  isPngBytes,
  screenshotFilename,
  SCREENSHOT_MAX_BYTES,
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
