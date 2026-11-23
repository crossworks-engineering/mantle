/**
 * The page types kit (./pdf-page-kinds.ts): the one check of what leaves the
 * box for a page ask (only the 8 fields, a copy), the columns the core puts
 * in the tab Pages, and the read back of what a database holds. M4: which
 * answers a read uses (pageKindsAt), the frame of a file (pdfFrameKindOf,
 * Q4), and a used answer's Kind over the Reader's own.
 */
import { describe, expect, it } from 'vitest';
import {
  PAGE_KIND_FROM,
  PAGE_KINDS_NOTE,
  PDF_PAGE_SAMPLE_MAX_CHARS,
  pageKindsAt,
  pageKindsOfRows,
  pagePictureName,
  pageRouteOfKind,
  pdfFrameKindOf,
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

/** A page with an answer of `deciderKind` at `conf` (rules kind unsure). */
const answered = (page: number, deciderKind: string, conf: number): PdfPageKind => ({
  page,
  kind: 'unsure',
  from: PAGE_KIND_FROM.shadow,
  deciderKind,
  deciderConfidence: conf,
});
const rulesOnly = (page: number, kind: string | null, from: string): PdfPageKind => ({
  page,
  kind,
  from,
  deciderKind: null,
  deciderConfidence: null,
});

describe('pageKindsAt: which answers a read uses (M4)', () => {
  const at = (live: boolean) => ({ live, floor: 0.6 });
  it('live: at or over the floor is decider, its Kind the answer; under it, low confidence', () => {
    const out = pageKindsAt([answered(1, 'pid', 0.6), answered(2, 'table', 0.59)], at(true));
    expect(out[0]).toMatchObject({ kind: 'pid', from: PAGE_KIND_FROM.decider });
    expect(out[1]).toMatchObject({ kind: 'unsure', from: PAGE_KIND_FROM.low });
  });

  it('shadow: no answer is used, whatever its sum, and the word is shadow', () => {
    const out = pageKindsAt([answered(1, 'pid', 0.99), answered(2, 'table', 0.2)], at(false));
    expect(out.map((k) => k.from)).toEqual([PAGE_KIND_FROM.shadow, PAGE_KIND_FROM.shadow]);
    expect(out.map((k) => k.kind)).toEqual(['unsure', 'unsure']);
  });

  it('a page once decider that is no longer used keeps no rules kind; pages with no answer as they are', () => {
    const was = { ...answered(1, 'pid', 0.9), kind: 'pid', from: PAGE_KIND_FROM.decider };
    const blank = rulesOnly(2, 'none', PAGE_KIND_FROM.blank);
    expect(pageKindsAt([was, blank], at(false))).toEqual([
      { ...was, kind: null, from: PAGE_KIND_FROM.shadow },
      blank,
    ]);
  });
});

describe('pdfFrameKindOf: the frame of a file (Q4, M4)', () => {
  const live = (ks: PdfPageKind[]) => pageKindsAt(ks, { live: true, floor: 0.6 });
  it('no used answer: the kind as named (shadow, a box with no page asks, all under the floor)', () => {
    expect(pdfFrameKindOf([], 'pid')).toBe('pid');
    expect(
      pdfFrameKindOf(pageKindsAt([answered(1, 'table', 0.9)], { live: false, floor: 0.6 }), 'scan'),
    ).toBe('scan');
    expect(pdfFrameKindOf(live([answered(1, 'table', 0.4)]), 'scan')).toBe('scan');
  });

  it('office pages win: the book (a scanned spec the rules put in the drawing lane)', () => {
    const ks = live([
      answered(1, 'document', 0.9),
      answered(2, 'table', 0.8),
      answered(3, 'pid', 0.9),
    ]);
    expect(pdfFrameKindOf(ks, 'scan')).toBe('book');
  });

  it('a tie goes to the book; blank pages and pages with no route do not vote', () => {
    const ks = [
      ...live([answered(1, 'datasheet', 0.9), answered(2, 'isometric', 0.9)]),
      rulesOnly(3, 'none', PAGE_KIND_FROM.blank),
      rulesOnly(4, 'other_drawing', PAGE_KIND_FROM.blank),
      rulesOnly(5, 'unsure', PAGE_KIND_FROM.cap),
    ];
    expect(pdfFrameKindOf(ks, 'unsure')).toBe('book');
  });

  it('a page with no used answer votes by its rules kind', () => {
    const ks = [
      ...live([answered(1, 'document', 0.9)]),
      rulesOnly(2, 'scan', PAGE_KIND_FROM.dayCap),
      rulesOnly(3, 'pid', PAGE_KIND_FROM.cap),
    ];
    expect(pdfFrameKindOf(ks, 'unsure')).toBe('unsure');
  });

  it('drawing wins: a drawing kind or a book stays, else unsure (the frame picks the lane, never a kind of its own)', () => {
    const ks = live([answered(1, 'pfd', 0.9), answered(2, 'pfd', 0.9), answered(3, 'pid', 0.9)]);
    expect(pdfFrameKindOf(ks, 'pid')).toBe('pid');
    expect(pdfFrameKindOf(ks, 'scan')).toBe('scan');
    // A raster set the rules left unsure keeps the readers of unsure.
    expect(pdfFrameKindOf(ks, 'unsure')).toBe('unsure');
    // A book stays a book (its reader reads in windows; its drawing pages
    // go to the sheet read by lane).
    expect(pdfFrameKindOf(ks, 'book')).toBe('book');
    expect(pdfFrameKindOf(ks, 'table')).toBe('unsure');
  });

  it('the routes of a kind', () => {
    expect(['document', 'table', 'datasheet'].map(pageRouteOfKind)).toEqual([
      'office',
      'office',
      'office',
    ]);
    expect(
      ['pid', 'pfd', 'isometric', 'equipment_drawing', 'other_drawing', 'scan'].map(
        pageRouteOfKind,
      ),
    ).toEqual(Array(6).fill('drawing'));
    expect(['unsure', 'none', 'book', null].map(pageRouteOfKind)).toEqual([null, null, null, null]);
  });
});

describe('withPageKinds: a used answer names Kind over the Reader (M4)', () => {
  it("the drawing reader's own Kind gives way to a used answer, and only to one", () => {
    const pages: ParsedSheet = {
      name: 'Pages',
      columns: [
        { name: 'Page', type: 'number' },
        { name: 'Kind', type: 'text' },
        { name: 'Kind from', type: 'text' },
      ],
      rows: [
        [1, 'scan', 'rules'],
        [2, 'scan', 'rules'],
      ],
    };
    const ks = pageKindsAt([answered(1, 'table', 0.9), answered(2, 'table', 0.3)], {
      live: true,
      floor: 0.6,
    });
    const [out] = withPageKinds({ sheets: [pages] }, ks).sheets;
    expect(out!.rows).toEqual([
      [1, 'table', 'decider', 'table', 0.9],
      [2, 'scan', 'rules: low confidence', 'table', 0.3],
    ]);
  });
});
