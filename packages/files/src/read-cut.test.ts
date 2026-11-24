/**
 * A read in part, said out loud (./read-cut.ts, ./read-cut-sink.ts): the one
 * shape of a cut, its sentence, its check, and the sink a reader says it in.
 */
import { describe, expect, it } from 'vitest';
import {
  addReadCut,
  cutMakesPartial,
  hasPartialReadCut,
  hasReadCut,
  readCutHint,
  readCutReason,
  readCutViews,
  readCutsOf,
} from './read-cut';
import { currentReadCuts, noteReadCut, noteReadCuts, withReadCutSink } from './read-cut-sink';
import { extractionOf } from './extraction-status';

const LATER = '2026-11-19T10:05:00.000Z';

describe('read cuts: the shape and its check', () => {
  it('keeps a well-formed entry and drops anything else', () => {
    expect(
      readCutsOf({
        sheet_rows: { what: 'rows', read: 5000, total: 12000, limit: 5000 },
        'agent_text:pdf-sheet-read': { what: 'characters', read: 64000, total: 90000 },
        bad_read: { what: 'rows', read: -1 },
        no_what: { read: 3 },
        'Bad Key': { what: 'rows', read: 1 },
        nested: 'text',
      }),
    ).toEqual({
      sheet_rows: { what: 'rows', read: 5000, total: 12000, limit: 5000 },
      'agent_text:pdf-sheet-read': { what: 'characters', read: 64000, total: 90000 },
    });
    expect(readCutsOf(null)).toEqual({});
    expect(readCutsOf([{ what: 'rows', read: 1 }])).toEqual({});
  });

  it('a key names its reason before any part', () => {
    expect(readCutReason('agent_text:iso-title-block')).toBe('agent_text');
    expect(readCutReason('sheet_rows')).toBe('sheet_rows');
  });

  it('a stored map with any entry is a cut said; an empty one is none', () => {
    expect(hasReadCut({ sheet_rows: { what: 'rows', read: 1, total: 2 } })).toBe(true);
    expect(hasReadCut({})).toBe(false);
    expect(hasReadCut(null)).toBe(false);
    expect(hasReadCut([1])).toBe(false);
  });

  it('two cuts of one key add up, with the larger limit and a lower bound kept', () => {
    expect(
      addReadCut(
        { what: 'rows', read: 5000, total: 8000, limit: 5000 },
        { what: 'rows', read: 5000, total: 6000, atLeast: true, limit: 5000 },
      ),
    ).toEqual({ what: 'rows', read: 10000, total: 14000, atLeast: true, limit: 5000 });
  });
});

describe('read cuts: the sentence of each', () => {
  it('says what was read of what there was, and what is not in search', () => {
    expect(readCutHint('sheet_rows', { what: 'rows', read: 5000, total: 12000, limit: 5000 })).toBe(
      "5,000 of 12,000 rows are in its text (at most 5,000 rows a sheet). The other rows are not in search; file_sql reads them from the file's database when it has one.",
    );
    expect(readCutHint('sheet_text', { what: 'sheets', read: 64, total: 120 })).toMatch(
      /^64 of 120 sheets are in its text/,
    );
    expect(readCutHint('pictures_small', { what: 'pictures', read: 12, total: 20 })).toMatch(
      /^8 of 20 pictures were left out: under 200 pixels/,
    );
    expect(
      readCutHint('vision_answer', { what: 'answers', read: 0, total: 1, limit: 2000 }),
    ).toMatch(/^1 picture description stopped at the model's answer limit \(2,000 tokens\)/);
    expect(readCutHint('description', { what: 'characters', read: 4000, total: 9000 })).toBe(
      '4,000 of 9,000 characters of its description were kept (a 4,000-character limit).',
    );
    // A lower bound says so.
    expect(
      readCutHint('pictures', { what: 'pictures', read: 500, total: 610, atLeast: true }),
    ).toMatch(/^500 of at least 610 pictures kept\./);
  });

  it('an unknown reason still says it read in part', () => {
    expect(readCutHint('new_reader_cap', { what: 'frames', read: 10, total: 40 })).toBe(
      '10 of 40 frames were read. The rest is not in search.',
    );
  });

  it('the views are in key order, each with its sentence', () => {
    const views = readCutViews({
      text_store: { what: 'characters', read: 1_000_000, total: 1_500_000 },
      sheet_rows: { what: 'rows', read: 5000, total: 7000 },
    });
    expect(views.map((v) => v.key)).toEqual(['sheet_rows', 'text_store']);
    expect(views[1]!.hint).toMatch(/^1,000,000 of 1,500,000 characters/);
  });
});

describe('the sink: a reader says it, the read that opened it hears it', () => {
  it('collects the notes made under it, added up by key', async () => {
    const { value, cuts } = await withReadCutSink(async () => {
      noteReadCut('sheet_rows', { what: 'rows', read: 5000, total: 6000 });
      await Promise.resolve();
      noteReadCut('sheet_rows', { what: 'rows', read: 5000, total: 9000 });
      noteReadCuts({ markup_bytes: { what: 'bytes', read: 10, total: 20 }, junk: 1 });
      expect(Object.keys(currentReadCuts()).sort()).toEqual(['markup_bytes', 'sheet_rows']);
      return 'done';
    });
    expect(value).toBe('done');
    expect(cuts).toEqual({
      sheet_rows: { what: 'rows', read: 10000, total: 15000 },
      markup_bytes: { what: 'bytes', read: 10, total: 20 },
    });
  });

  it('with no sink open, a note goes nowhere', () => {
    noteReadCut('sheet_rows', { what: 'rows', read: 1, total: 2 });
    expect(currentReadCuts()).toEqual({});
  });

  it('two reads at once keep their own cuts', async () => {
    const [a, b] = await Promise.all([
      withReadCutSink(async () => {
        await new Promise((r) => setTimeout(r, 5));
        noteReadCut('sheet_rows', { what: 'rows', read: 1, total: 2 });
      }),
      withReadCutSink(async () => {
        noteReadCut('markup_bytes', { what: 'bytes', read: 1, total: 2 });
      }),
    ]);
    expect(Object.keys(a.cuts)).toEqual(['sheet_rows']);
    expect(Object.keys(b.cuts)).toEqual(['markup_bytes']);
  });
});

describe('extractionOf: one model for every cut', () => {
  it('a read with a reader cut is partial, with its cuts and their sentences', () => {
    const x = extractionOf({
      extract_completed_at: LATER,
      read_cut: { sheet_rows: { what: 'rows', read: 5000, total: 12000, limit: 5000 } },
    });
    expect(x.state).toBe('partial');
    expect(x.cuts).toEqual([
      expect.objectContaining({ key: 'sheet_rows', read: 5000, total: 12000 }),
    ]);
    expect(x.hint).toMatch(/5,000 of 12,000 rows/);
  });

  it("a scan's pages, the pictures kept and a reader's cut are all entries", () => {
    const x = extractionOf({
      extract_completed_at: LATER,
      ocr: { pages_read: 10, pages_total: 679 },
      images: { kept: 3, found: 5 },
      read_cut: { text_store: { what: 'characters', read: 1_000_000, total: 2_000_000 } },
    });
    expect(x).toMatchObject({
      state: 'partial',
      pages: { read: 10, total: 679 },
      pictures: { kept: 3, found: 5 },
    });
    expect(x.cuts!.map((c) => c.key)).toEqual(['ocr_pages', 'pictures', 'text_store']);
    expect(x.hint).toMatch(/10 of 679 pages were read/);
    expect(x.hint).toMatch(/3 of 5 pictures kept/);
  });

  it('pictures alone left out is partial; all kept is indexed', () => {
    expect(extractionOf({ extract_completed_at: LATER, images: { kept: 2, found: 9 } }).state).toBe(
      'partial',
    );
    expect(extractionOf({ extract_completed_at: LATER, images: { kept: 9, found: 9 } }).state).toBe(
      'indexed',
    );
  });

  it('a map the rule cannot read is still a cut said (as the SQL form)', () => {
    const x = extractionOf({ extract_completed_at: LATER, read_cut: { 'Bad Key': 1 } });
    expect(x.state).toBe('partial');
    expect(x.cuts).toEqual([]);
    expect(x.hint).toMatch(/read in part/);
  });

  it('an empty map, or a failed read, is no cut', () => {
    expect(extractionOf({ extract_completed_at: LATER, read_cut: {} }).state).toBe('indexed');
    expect(
      extractionOf({
        extract_skipped: { reason: 'document_unreadable', at: LATER },
        read_cut: { sheet_rows: { what: 'rows', read: 1, total: 2 } },
      }).state,
    ).toBe('failed');
    // Not read yet: the cut of an older read waits for its stamp.
    expect(
      extractionOf({ read_cut: { sheet_rows: { what: 'rows', read: 1, total: 2 } } }).state,
    ).toBe('pending');
  });
});

describe('the sentences of the newer cuts', () => {
  it('sheets past the import ceiling, and a feed description left out whole', () => {
    expect(
      readCutHint('database_rows', { what: 'rows', read: 0, total: 2_500_000, limit: 2_000_000 }),
    ).toBe(
      'No database was built: its sheets hold 2,500,000 rows, past the 2,000,000 row limit, so file_sql has no rows of it. Its text is read as usual.',
    );
    // Read in part since the ingest program: the first rows go in.
    expect(
      readCutHint('database_rows', {
        what: 'rows',
        read: 2_000_000,
        total: 2_500_000,
        limit: 2_000_000,
      }),
    ).toBe(
      '2,000,000 of 2,500,000 rows are in its database (the 2,000,000 row limit), so file_sql has no rows past them. Its text is read as usual.',
    );
    expect(
      readCutHint('database_size', { what: 'rows', read: 10, total: 40, limit: 33_554_432 }),
    ).toBe(
      '10 of 40 rows are in its database: the rest are past the 33,554,432 byte a file database read had room for, so file_sql has no rows past them. Its text is read as usual.',
    );
    expect(readCutHint('sheet_text', { what: 'sheets', read: 1, total: 5 })).toBe(
      '1 of 5 sheets are in its text: the read of a large workbook stops in its first long sheet. The other sheets are not in search.',
    );
    expect(
      readCutHint('database_size', {
        what: 'rows',
        read: 10,
        total: 11,
        atLeast: true,
        limit: 33_554_432,
      }),
    ).toMatch(/^10 of at least 11 rows are in its database/);
    expect(readCutHint('description', { what: 'characters', read: 0, total: 9000 })).toBe(
      'Its description (9,000 characters) was left out: the feed was too large to send with it.',
    );
  });
});

describe('details only (the owner, 2026-11-19: "No, details only")', () => {
  const done = { extract_completed_at: '2026-11-19T00:00:00Z' };

  it('icons and small pictures the size gate skipped leave a file indexed, with the cuts as details', () => {
    const x = extractionOf({
      ...done,
      read_cut: {
        pictures_small: { what: 'pictures', read: 2, total: 9 },
        pictures_tiny: { what: 'pictures', read: 8, total: 9 },
      },
    });
    expect(x.state).toBe('indexed');
    expect(x.hint).toBeUndefined();
    expect(x.cuts?.map((c) => c.key)).toEqual(['pictures_small', 'pictures_tiny']);
    expect(x.cuts?.[0]?.hint).toMatch(/under 200 pixels/);
  });

  it('every other cut still makes it partial; the hint leaves the details out', () => {
    for (const key of [
      'pictures_metafile',
      'pictures_unreadable',
      'pictures_large',
      'sheet_rows',
    ]) {
      const x = extractionOf({
        ...done,
        read_cut: {
          pictures_small: { what: 'pictures', read: 2, total: 9 },
          [key]: { what: 'pictures', read: 8, total: 9 },
        },
      });
      expect(x.state, key).toBe('partial');
      expect(x.cuts, key).toHaveLength(2);
      expect(x.hint, key).not.toMatch(/under 200 pixels/);
    }
  });

  it('a local read with details only keeps its own reason', () => {
    const x = extractionOf({
      ...done,
      indexing_applied: 'local',
      read_cut: { pictures_tiny: { what: 'pictures', read: 1, total: 2 } },
    });
    expect(x).toMatchObject({ state: 'indexed', reason: 'local_only' });
    expect(x.cuts).toHaveLength(1);
  });

  it('the key test, the map test', () => {
    expect(cutMakesPartial('pictures_small')).toBe(false);
    expect(cutMakesPartial('pictures_tiny')).toBe(false);
    expect(cutMakesPartial('pictures_metafile')).toBe(true);
    expect(cutMakesPartial('agent_text:pdf-sheet-read')).toBe(true);
    expect(hasPartialReadCut({ pictures_small: { what: 'pictures', read: 1, total: 2 } })).toBe(
      false,
    );
    expect(
      hasPartialReadCut({
        pictures_small: { what: 'pictures', read: 1, total: 2 },
        markup_bytes: { what: 'bytes', read: 1, total: 2 },
      }),
    ).toBe(true);
    expect(hasPartialReadCut({})).toBe(false);
  });
});

describe('the order of the sentences', () => {
  it("a scan's pages, the pictures kept, a book's page pictures, then the readers' cuts", () => {
    const x = extractionOf({
      extract_completed_at: '2026-11-19T00:00:00Z',
      ocr: { pages_read: 9, pages_total: 10 },
      images: {
        embedded: { kept: 3, found: 4 },
        pages: { kept: 1, found: 2 },
        kept: 4,
        found: 6,
      },
      read_cut: { markup_bytes: { what: 'bytes', read: 1, total: 2 } },
    });
    expect(x.cuts?.map((c) => c.key)).toEqual([
      'ocr_pages',
      'pictures',
      'page_pictures',
      'markup_bytes',
    ]);
    expect(x.hint).toMatch(
      /^Only 9 of 10 pages were read\. .* 3 of 4 pictures kept\. .* 1 of 2 pages left to vision/,
    );
  });
});
