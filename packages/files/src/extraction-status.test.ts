import { describe, expect, it } from 'vitest';

import { READ_FAILURE_SKIPS } from '@mantle/db';
import { extractionOf, picturesStampOf } from './extraction-status';

const T = '2026-11-18T10:00:00.000Z';
const LATER = '2026-11-18T10:05:00.000Z';

describe('extractionOf: did the brain read the content', () => {
  it('a file the parser refused is failed, whatever indexing_applied says', () => {
    // The VCC case: the mode stamp says "full", the read failed.
    const x = extractionOf({
      indexing_applied: 'full',
      extract_skipped: { reason: 'document_unreadable', at: LATER },
    });
    expect(x.state).toBe('failed');
    expect(x.reason).toBe('document_unreadable');
    expect(x.hint).toMatch(/not in search/);
  });

  it('a skip with nothing to read is skipped, not failed', () => {
    expect(extractionOf({ extract_skipped: { reason: 'body_too_short', at: LATER } }).state).toBe(
      'skipped',
    );
  });

  it('a verdict holds while its key is there: a rename after it reads nothing (audit M1)', () => {
    // The verdict was stamped before the last write (a rename), and the file
    // is still not read.
    expect(extractionOf({ extract_skipped: { reason: 'pdf_too_large', at: T } }).state).toBe(
      'failed',
    );
  });

  it('a scan read in part is partial, with its pages', () => {
    const x = extractionOf({
      extract_completed_at: LATER,
      ocr: { pages_read: 10, pages_total: 679 },
    });
    expect(x).toMatchObject({ state: 'partial', pages: { read: 10, total: 679 } });
    expect(x.hint).toMatch(/10 of 679 pages were read/);
  });

  it('a whole read is indexed; a local read says so', () => {
    expect(extractionOf({ extract_completed_at: LATER, ocr: true })).toEqual({
      state: 'indexed',
    });
    expect(extractionOf({ extract_completed_at: LATER, indexing_applied: 'local' })).toMatchObject({
      state: 'indexed',
      reason: 'local_only',
    });
  });

  it('name only, parked, and not read yet', () => {
    expect(extractionOf({ indexing_applied: 'metadata' }).state).toBe('name_only');
    expect(extractionOf({ extract_parked: { at: LATER } })).toMatchObject({
      state: 'failed',
      reason: 'parked',
    });
    expect(extractionOf({ indexing_applied: 'full' }).state).toBe('pending');
    expect(extractionOf(null).state).toBe('pending');
  });
});

describe('the read failures are one list', () => {
  it('every verdict the admins hear of is a failed file, and no other', () => {
    for (const reason of READ_FAILURE_SKIPS) {
      expect(extractionOf({ extract_skipped: { reason, at: LATER } }).state, reason).toBe('failed');
    }
    for (const reason of ['needs_export', 'no_parser', 'body_too_short', 'unsupported_media']) {
      expect(extractionOf({ extract_skipped: { reason, at: LATER } }).state, reason).toBe(
        'skipped',
      );
    }
  });

  it('pictures left out make a read file partial, N of M pictures kept (G4)', () => {
    const x = extractionOf({ extract_completed_at: LATER, images: { kept: 500, found: 520 } });
    expect(x).toMatchObject({ state: 'partial', pictures: { kept: 500, found: 520 } });
    expect(x.hint).toMatch(/^500 of 520 pictures kept\./);
    // Every picture kept: no badge.
    expect(
      extractionOf({ extract_completed_at: LATER, images: { kept: 520, found: 520 } }).state,
    ).toBe('indexed');
  });

  it('a book with a page window not read and pictures left out says both', () => {
    const x = extractionOf({
      extract_completed_at: LATER,
      ocr: { pages_read: 950, pages_total: 1000 },
      images: { kept: 3, found: 4 },
    });
    expect(x).toMatchObject({ state: 'partial', pages: { read: 950, total: 1000 } });
    expect(x.hint).toMatch(/950 of 1000 pages were read/);
    expect(x.hint).toMatch(/3 of 4 pictures kept/);
  });

  it('a count of pictures cut short says at least', () => {
    const x = extractionOf({
      extract_completed_at: LATER,
      images: { kept: 500, found: 610, more: true },
    });
    expect(x.hint).toMatch(/^500 of at least 610 pictures kept\./);
  });
});

describe("a file's pictures left out, by part (G1, G4)", () => {
  it('each owner stamps its own part; the sums are read; the other part stands', () => {
    // An older stamp with no parts is the core's (embedded) part.
    const pages = picturesStampOf({ kept: 2, found: 3 }, 'pages', { kept: 1, found: 4 });
    expect(pages).toEqual({
      embedded: { kept: 2, found: 3 },
      pages: { kept: 1, found: 4 },
      kept: 3,
      found: 7,
    });
    // The core counts again and keeps all: its part goes, the pages stand.
    expect(picturesStampOf(pages, 'embedded', { kept: 5, found: 5 })).toEqual({
      pages: { kept: 1, found: 4 },
      kept: 1,
      found: 4,
    });
    // Every part whole: the key goes.
    expect(
      picturesStampOf({ pages: { kept: 1, found: 4 } }, 'pages', { kept: 4, found: 4 }),
    ).toBeNull();
    // A count cut short says `more`; a kept past the found is the found.
    expect(picturesStampOf(undefined, 'embedded', { kept: 9, found: 9, more: true })).toBeNull();
    expect(picturesStampOf(undefined, 'embedded', { kept: 1, found: 3, more: true })).toEqual({
      embedded: { kept: 1, found: 3, more: true },
      kept: 1,
      found: 3,
      more: true,
    });
  });

  it("a book's marked pages not read yet say how to read them", () => {
    const x = extractionOf({
      extract_completed_at: LATER,
      images: picturesStampOf(undefined, 'pages', { kept: 2, found: 5 }),
    });
    expect(x).toMatchObject({ state: 'partial', pictures: { kept: 2, found: 5 } });
    expect(x.hint).toBe(
      '2 of 5 pages left to vision are read. The others keep their OCR text only: run the Agent pdf-page-read on the book to read them.',
    );
  });
});
