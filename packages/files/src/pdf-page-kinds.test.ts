/**
 * The page types kit (./pdf-page-kinds.ts): the one check of what leaves the
 * box for a page ask (only the 8 fields, a copy), the columns the core puts
 * in the tab Pages, and the read back of what a database holds.
 */
import { describe, expect, it } from 'vitest';
import {
  PAGE_KIND_FROM,
  PAGE_KINDS_NOTE,
  PDF_PAGE_SAMPLE_MAX_CHARS,
  pageKindsOfRows,
  pagePictureName,
  pdfPageAskOf,
  withPageKinds,
  type PdfPageKind,
} from './pdf-page-kinds';
import type { ParsedSheet } from './sheet-to-grid';

const ASK = {
  page: 12,
  picture: 'page-12.jpg',
  size: 'a4',
  class: 'scan_hidden_text',
  instrument_tags: 0,
  line_numbers: 2,
  tag_like_tokens: 5,
  text_sample: 'SPECIFICATION GENERAL NOTES',
};

describe('pdfPageAskOf, the one check of a page ask', () => {
  it('gives a copy of the 8 fields only: any other key stays behind', () => {
    const out = pdfPageAskOf({ ...ASK, text: 'the whole page', pictureBytes: 'x', nested: {} });
    expect(out).toEqual(ASK);
    expect(Object.keys(out!).sort()).toEqual(Object.keys(ASK).sort());
    expect(out).not.toBe(ASK);
  });

  it('refuses any other shape', () => {
    const bad: Record<string, unknown>[] = [
      { ...ASK, page: 0 },
      { ...ASK, page: 1.5 },
      { ...ASK, picture: 'page-13.jpg' },
      { ...ASK, picture: '../secret.jpg' },
      { ...ASK, size: 'letter' },
      { ...ASK, class: 'photo' },
      { ...ASK, instrument_tags: -1 },
      { ...ASK, line_numbers: '2' },
      { ...ASK, text_sample: 'x'.repeat(PDF_PAGE_SAMPLE_MAX_CHARS + 1) },
      { ...ASK, text_sample: undefined },
    ];
    for (const b of bad) expect(pdfPageAskOf(b)).toBeNull();
    expect(pdfPageAskOf(null)).toBeNull();
    expect(pdfPageAskOf([ASK])).toBeNull();
    // A page the reader could not size or class is still a page.
    expect(pdfPageAskOf({ ...ASK, size: null, class: null })).not.toBeNull();
    expect(pagePictureName(12)).toBe(ASK.picture);
  });
});

const kinds: PdfPageKind[] = [
  {
    page: 1,
    kind: 'document',
    from: PAGE_KIND_FROM.shadow,
    deciderKind: 'table',
    deciderConfidence: 0.91,
  },
  { page: 2, kind: 'none', from: PAGE_KIND_FROM.blank, deciderKind: null, deciderConfidence: null },
];

describe('withPageKinds, the columns of the tab Pages', () => {
  it('the book reader: the four columns are added, by page', () => {
    const pages: ParsedSheet = {
      name: 'Pages',
      columns: [
        { name: 'Page', type: 'number' },
        { name: 'Text', type: 'text' },
      ],
      rows: [
        [1, 'one'],
        [2, ''],
        [3, 'three'],
      ],
    };
    const [out] = withPageKinds({ sheets: [pages] }, kinds).sheets;
    expect(out!.columns.map((c) => c.name)).toEqual([
      'Page',
      'Text',
      'Kind',
      'Kind from',
      'Decider kind',
      'Decider confidence',
    ]);
    expect(out!.rows).toEqual([
      [1, 'one', 'document', 'rules: shadow', 'table', 0.91],
      [2, '', 'none', 'rules: blank', null, null],
      [3, 'three', null, null, null, null],
    ]);
  });

  it("the drawing reader: its own Kind stays, Kind from is the page type's", () => {
    const pages: ParsedSheet = {
      name: 'Pages',
      columns: [
        { name: 'Page', type: 'number' },
        { name: 'Kind', type: 'text' },
        { name: 'Kind from', type: 'text' },
      ],
      rows: [[1, 'pid', 'picture']],
    };
    const [out] = withPageKinds({ sheets: [pages] }, kinds).sheets;
    expect(out!.rows).toEqual([[1, 'pid', 'rules: shadow', 'table', 0.91]]);
  });

  it('no page types: the sheets and the description as they are (a box with no page ask)', () => {
    const sheets: ParsedSheet[] = [{ name: 'Pages', columns: [], rows: [] }];
    expect(withPageKinds({ sheets, description: 'A P&ID.' }, [])).toEqual({
      sheets,
      description: 'A P&ID.',
    });
  });

  it('page types bring their note to the description, on every path (one place)', () => {
    const pages: ParsedSheet = {
      name: 'Pages',
      columns: [{ name: 'Page', type: 'number' }],
      rows: [[1]],
    };
    // A Reader's description (an upload, a read again, the sketch read).
    expect(withPageKinds({ sheets: [pages], description: 'A P&ID.' }, kinds).description).toBe(
      `A P&ID. ${PAGE_KINDS_NOTE}`,
    );
    // No description: the note alone.
    expect(withPageKinds({ sheets: [pages] }, kinds).description).toBe(PAGE_KINDS_NOTE);
  });

  it('reads back what it wrote; a row of a Reader before M3 holds no type', () => {
    const rows = [
      {
        Page: 1,
        Kind: 'document',
        'Kind from': 'rules: shadow',
        'Decider kind': 'table',
        'Decider confidence': 0.91,
      },
      {
        Page: 2,
        Kind: 'none',
        'Kind from': 'rules: blank',
        'Decider kind': null,
        'Decider confidence': null,
      },
      {
        Page: 3,
        Kind: 'pid',
        'Kind from': 'picture',
        'Decider kind': null,
        'Decider confidence': null,
      },
      { Page: 4, Kind: null, 'Kind from': null, 'Decider kind': null, 'Decider confidence': null },
    ];
    expect(pageKindsOfRows(rows)).toEqual(kinds);
  });
});
