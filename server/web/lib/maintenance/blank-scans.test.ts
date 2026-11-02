/**
 * blank-scans' pure parts (lib/maintenance/blank-scans.ts): the byte search
 * that decides which files are read again (and paid for), and the date that
 * keeps a file read after the fix from being sent at all.
 */
import { describe, expect, it } from 'vitest';
import {
  applyGate,
  blankCodecsIn,
  likelyBlank,
  parseBefore,
  readBefore,
  type BlankCandidate,
} from './blank-scans';
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
    textChars: 0,
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

describe('applyGate', () => {
  const now = new Date('2026-11-20T10:00:00Z');

  it('a dry run needs no date; --apply needs one, in the past', () => {
    expect(applyGate(false, undefined, now)).toEqual({ ok: true, before: null });
    expect(applyGate(true, '2026-11-03', now)).toEqual({
      ok: true,
      before: new Date('2026-11-03T00:00:00Z'),
    });
    expect(applyGate(true, undefined, now)).toMatchObject({ ok: false });
    expect(applyGate(false, 'yesterday', now)).toMatchObject({ ok: false });
    expect(applyGate(true, 'yesterday', now)).toMatchObject({ ok: false });
  });

  it('refuses a date after today: a typo of the month would put back files read right', () => {
    expect(applyGate(true, '2026-12-03', now)).toMatchObject({ ok: false });
    expect(applyGate(false, '2026-12-03', now)).toMatchObject({ ok: false });
  });
});

describe('likelyBlank', () => {
  const c = (kind: BlankCandidate['kind'], textChars: number): BlankCandidate => ({
    id: 'x',
    kind,
    readAt: '2026-09-01T00:00:00Z',
    textChars,
  });

  it('page OCR that read nothing is always read again', () => {
    expect(likelyBlank(c('no_text', 0), 3, 200)).toBe(true);
  });

  it('page OCR text is read again only when it is a sentence a page or less', () => {
    expect(likelyBlank(c('ocr_text', 60), 1, 200)).toBe(true);
    expect(likelyBlank(c('ocr_text', 400), 2, 200)).toBe(true);
    expect(likelyBlank(c('ocr_text', 401), 2, 200)).toBe(false);
    expect(likelyBlank(c('ocr_text', 3000), 4, 200)).toBe(false);
    // Page OCR read only the first 10 pages of a long scan: measured on those.
    expect(likelyBlank(c('ocr_text', 2000), 100, 200)).toBe(true);
    expect(likelyBlank(c('ocr_text', 15000), 100, 200)).toBe(false);
  });
});
