/**
 * blank-scans' pure parts (lib/maintenance/blank-scans.ts): the byte search
 * that decides which files are read again (and paid for), and the date that
 * keeps a file read after the fix from being sent at all.
 */
import { describe, expect, it } from 'vitest';
import { blankCodecsIn, parseBefore, readBefore, type BlankCandidate } from './blank-scans';
import { helveticaPdf, scanPdf } from '../../../../packages/files/src/pdf-fixtures.test-helper';

describe('blankCodecsIn', () => {
  it('finds each codec in a real scan, and none in a plain one', () => {
    expect(blankCodecsIn(scanPdf('jpx'))).toEqual(['/JPXDecode']);
    expect(blankCodecsIn(scanPdf('ccitt'))).toEqual(['/CCITTFaxDecode']);
    expect(blankCodecsIn(scanPdf('jbig2'))).toEqual(['/JBIG2Decode']);
    // Flate drew before the fix: not a candidate.
    expect(blankCodecsIn(scanPdf('flate'))).toEqual([]);
    expect(blankCodecsIn(helveticaPdf())).toEqual([]);
  });

  it('reads the name as bytes, wherever it sits in the file', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0x00, 0x80]),
      Buffer.from('<< /Filter [/FlateDecode /JBIG2Decode] >>', 'latin1'),
      Buffer.from([0xfe, 0x00]),
    ]);
    expect(blankCodecsIn(bytes)).toEqual(['/JBIG2Decode']);
  });
});

describe('parseBefore', () => {
  it('takes a day or a full UTC time', () => {
    expect(parseBefore('2026-11-03')?.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(parseBefore('2026-11-03T08:30:00Z')?.toISOString()).toBe('2026-11-03T08:30:00.000Z');
  });

  it('refuses anything else, so --apply never runs on a guess', () => {
    for (const v of [undefined, '', 'yesterday', '2026-13-01', '03/11/2026', '2026-11-3'])
      expect(parseBefore(v), String(v)).toBeNull();
  });
});

describe('readBefore', () => {
  const c = (id: string, readAt: string | null): BlankCandidate => ({
    id,
    kind: 'no_text',
    readAt,
  });

  it('keeps only files read before the day, and leaves out a file with no read time', () => {
    const list = [
      c('old', '2026-10-01T10:00:00Z'),
      c('edge', '2026-11-03T00:00:00Z'),
      c('new', '2026-11-04T09:00:00Z'),
      c('none', null),
      c('bad', 'not a time'),
    ];
    expect(readBefore(list, new Date('2026-11-03T00:00:00Z')).map((x) => x.id)).toEqual(['old']);
  });
});
