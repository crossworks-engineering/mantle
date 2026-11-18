import { describe, expect, it } from 'vitest';

import { READ_FAILURE_SKIPS } from '@mantle/db';
import { extractionOf } from './extraction-status';

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
    expect(x.hint).toMatch(/1 to 10 of 679/);
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
});
