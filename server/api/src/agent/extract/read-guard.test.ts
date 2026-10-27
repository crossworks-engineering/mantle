/**
 * The crash stamp's reading (./read-guard.ts), with no database: which
 * stamps say a read took the process down, and which reads are guarded.
 */
import { describe, expect, it } from 'vitest';
import { crashedRead, crashedReadHint, guardsRead } from './read-guard';

const at = (d: Date) => d.toISOString();

describe('crashedRead', () => {
  const written = new Date('2026-10-27T10:00:00.000Z');

  it('names the pass of a current reading stamp', () => {
    const data = {
      extract_skipped: { reason: 'document_too_large', at: at(written), reading: 'pictures' },
    };
    expect(crashedRead({ data, updatedAt: written })).toBe('pictures');
  });

  it('ignores a stamp older than the last write (new bytes), a skip with no pass, and junk', () => {
    const before = new Date(written.getTime() - 1);
    expect(
      crashedRead({
        data: {
          extract_skipped: { reason: 'document_too_large', at: at(before), reading: 'text' },
        },
        updatedAt: written,
      }),
    ).toBeNull();
    expect(
      crashedRead({
        data: { extract_skipped: { reason: 'no_parser', at: at(written) } },
        updatedAt: written,
      }),
    ).toBeNull();
    expect(
      crashedRead({
        data: { extract_skipped: { reason: 'x', at: at(written), reading: 'anything' } },
        updatedAt: written,
      }),
    ).toBeNull();
    expect(crashedRead({ data: null, updatedAt: written })).toBeNull();
  });

  it('says which pass in its hint', () => {
    expect(crashedReadHint('ocr')).toContain('OCR page render');
  });
});

describe('guardsRead', () => {
  it('guards reads in this process, not the media sidecar exchange', () => {
    expect(guardsRead('pdf', 'pictures')).toBe(true);
    expect(guardsRead('pdf', 'ocr')).toBe(true);
    expect(guardsRead('dwf', 'text')).toBe(true);
    expect(guardsRead('dwf', 'pictures')).toBe(false);
    expect(guardsRead('dwg', 'text')).toBe(false);
    expect(guardsRead('dxf', 'tables')).toBe(false);
  });
});
