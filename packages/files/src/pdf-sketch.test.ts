/**
 * The sketch read's pure part: which pages are read, how an answer is
 * parsed, and what a read gives (rows, tabs, the file's text). Made-up
 * values only.
 */
import { describe, expect, it } from 'vitest';
import type { PdfDrawing, PdfDrawingPage } from './pdf-drawing';
import { pdfDrawingSheets, pdfFileTabOf } from './pdf-drawing-sheets';
import { SHAPES, shapesOf } from './pipelines/shapes';
import {
  SKETCH_MAX_PAGES,
  SKETCH_PIECE_MAX_CHARS,
  parsePieceAnswer,
  sketchMarkdown,
  sketchPageRead,
  sketchPageRows,
  sketchPagesOf,
  type SketchPagePieces,
  type SketchRead,
} from './pdf-sketch';

const page = (n: number, over: Partial<PdfDrawingPage> = {}): PdfDrawingPage => ({
  page: n,
  status: 'ok',
  class: 'scan',
  size: 'a4',
  widthMm: 297,
  heightMm: 210,
  rotate: 0,
  chars: 0,
  runs: 0,
  hiddenShare: 0,
  imageCover: 1,
  segments: 0,
  axes: null,
  tagLike: 0,
  instruments: 0,
  lineNumbers: 0,
  markups: 0,
  markupsWithText: 0,
  readMs: 1,
  kind: 'scan',
  kindFrom: 'picture',
  eye: null,
  ...over,
});
const drawing = (pages: PdfDrawingPage[], kind: PdfDrawing['kind'] = 'scan'): PdfDrawing => ({
  numPages: pages.length,
  pageCountMayBeShort: false,
  kind,
  pages,
  sample: '',
  allRead: true,
  largeImageNotRead: false,
});
const box = (x: number, y: number): [number, number, number, number] => [x, y, x + 0.1, y + 0.02];
const pieces = (over: Partial<SketchPagePieces> = {}): SketchPagePieces => ({
  page: 1,
  status: 'ok',
  dpi: 300,
  pieces: [
    { box: box(0.1, 0.1), picture: 0, scale: 1 },
    { box: box(0.1, 0.3), picture: 0, scale: 1 },
    { box: box(0.1, 0.5), picture: 1, scale: 1 },
  ],
  notSent: [],
  pictures: [Buffer.from([1]), Buffer.from([2])],
  ...over,
});

describe('sketchPagesOf', () => {
  it('takes the scan pages of a scan drawing, and no typed page', () => {
    const d = drawing([
      page(1),
      page(2, { class: 'text', kind: 'document' }),
      page(3, { class: 'vector_no_text', kind: 'other_drawing' }),
      page(4, { class: 'scan_hidden_text' }),
      page(5, { class: 'vector_text', kind: 'unsure' }),
      page(6, { status: 'too_large' }),
      // A scan page the pictures named a typed page.
      page(7, { kind: 'document' }),
    ]);
    expect(sketchPagesOf(d)).toEqual({ pages: [1, 3, 4], pastCap: [] });
  });

  it('takes no page of a file whose kind is no sketch kind', () => {
    for (const kind of ['pid', 'unsure', 'document', 'datasheet'] as const) {
      expect(sketchPagesOf(drawing([page(1)], kind)).pages).toEqual([]);
    }
    // The kind the database holds wins over the rules' own (a decider's kind).
    expect(sketchPagesOf(drawing([page(1)], 'unsure'), 'isometric').pages).toEqual([1]);
  });

  it('reads the first pages up to the cap, and states the others', () => {
    const d = drawing(Array.from({ length: SKETCH_MAX_PAGES + 3 }, (_, i) => page(i + 1)));
    const { pages, pastCap } = sketchPagesOf(d);
    expect(pages).toHaveLength(SKETCH_MAX_PAGES);
    expect(pastCap).toEqual([SKETCH_MAX_PAGES + 1, SKETCH_MAX_PAGES + 2, SKETCH_MAX_PAGES + 3]);
  });
});

describe('parsePieceAnswer', () => {
  const all = new Set([1, 2, 3, 4, 5]);

  it('takes one line a piece, and keeps the text as written', () => {
    const got = parsePieceAnswer('1: 4"-P-1001-A1B\n2: FT-101 | NOTE 3\n 3 :  PSV-12 \n', all);
    expect([...got]).toEqual([
      [1, '4"-P-1001-A1B'],
      [2, 'FT-101 | NOTE 3'],
      [3, 'PSV-12'],
    ]);
  });

  it('takes a list item, a word before the number, and another mark after it', () => {
    const got = parsePieceAnswer(
      '- 1: TK-7\n* 2: P-101\nPiece 3: E-12\n4. FIC-101\n5) PT-202\n1.5" is no piece line',
      all,
    );
    expect([...got]).toEqual([
      [1, 'TK-7'],
      [2, 'P-101'],
      [3, 'E-12'],
      [4, 'FIC-101'],
      [5, 'PT-202'],
    ]);
  });

  it('a piece with nothing after its number, or with no line, has no text', () => {
    const got = parsePieceAnswer('1:\n2:   \n4: U2-E-12A', all);
    expect([...got.keys()]).toEqual([4]);
  });

  it('drops a number the picture does not hold, words around the answer, and a second line of a number', () => {
    const got = parsePieceAnswer(
      'Here is the text:\n**1**: TK-7\n9: MADE UP BY THE MODEL\n1: SECOND\n`2`: `U2-V-9`\nDone.',
      new Set([1, 2]),
    );
    expect([...got]).toEqual([
      [1, 'TK-7'],
      [2, 'U2-V-9'],
    ]);
  });

  it('cuts a text past the piece limit and takes control characters out', () => {
    const got = parsePieceAnswer(
      `1: ${'A'.repeat(SKETCH_PIECE_MAX_CHARS + 50)}\n2: A\u0000B\tC`,
      all,
    );
    expect(got.get(1)).toHaveLength(SKETCH_PIECE_MAX_CHARS);
    expect(got.get(2)).toBe('A B C');
  });
});

describe('sketchPageRead', () => {
  it('puts each answer on its pieces, by the picture a piece is in', () => {
    // Piece 3 is in the second picture: a `3:` in the first answer is not its text.
    const read = sketchPageRead(pieces(), ['1: FT-101\n3: WRONG PICTURE', '3: 4"-P-1001-A1B']);
    expect(read.status).toBe('ok');
    expect(read.pieces.map((p) => [p.text, p.asked])).toEqual([
      ['FT-101', true],
      [null, true],
      ['4"-P-1001-A1B', true],
    ]);
  });

  it('a picture whose call did not run leaves its pieces not asked', () => {
    const read = sketchPageRead(pieces(), ['1: FT-101\n2: TK-7', null]);
    expect(read.status).toBe('ok');
    expect(read.pieces.map((p) => [p.text, p.asked])).toEqual([
      ['FT-101', true],
      ['TK-7', true],
      [null, false],
    ]);
    // No picture of the page was read: the page says so.
    expect(sketchPageRead(pieces(), [null, null]).status).toBe('not_read');
    // A page with no pieces keeps its own status.
    const none = pieces({ status: 'no_picture', pieces: [], pictures: [] });
    expect(sketchPageRead(none, []).status).toBe('no_picture');
  });
});

describe('the rows of a read', () => {
  const read = sketchPageRead(pieces({ notSent: [box(0.8, 0.8)] }), [
    '1: FT-101 4"-P-1001-A1B\n2: plain words | U2-P-1A/B',
    null,
  ]);

  it('a word a row with its piece box; tags and line numbers by the grammar; a gap for each piece with no text', () => {
    const rows = sketchPageRows(read, 297, 210);
    expect(rows.words.map((w) => [w.line, w.text])).toEqual([
      [1, 'FT-101'],
      [1, '4"-P-1001-A1B'],
      [2, 'plain'],
      [2, 'words'],
      [2, 'U2-P-1A/B'],
    ]);
    expect(rows.words[0]!.box).toEqual(box(0.1, 0.1));
    expect(rows.tags.map((t) => [t.tag, t.type, t.source, t.confidence])).toEqual([
      ['FT-101', 'instrument', 'ocr', 0.65],
      ['U2-P-1A', 'equipment', 'ocr', 0.6],
      ['U2-P-1B', 'equipment', 'ocr', 0.6],
    ]);
    // Every value a model read is one to check.
    expect(rows.tags.every((t) => t.confidence < 0.8)).toBe(true);
    expect(rows.lines.map((l) => [l.line, l.source])).toEqual([['4"-P-1001-A1B', 'ocr']]);
    expect(rows.gaps).toEqual([
      { box: box(0.1, 0.5), why: 'not_read' },
      { box: box(0.8, 0.8), why: 'not_sent' },
    ]);
  });

  it('a word takes its region from the title block box it is passed, the default when none is', () => {
    const regions = (rows: ReturnType<typeof sketchPageRows>) =>
      rows.words.map((w) => [w.line, w.region]);
    expect(regions(sketchPageRows(read, 297, 210))).toEqual([
      [1, 'body'],
      [1, 'body'],
      [2, 'body'],
      [2, 'body'],
      [2, 'body'],
    ]);
    // Wide and high enough for the second piece, not for the first.
    const wider = { width: 260, height: 150 };
    expect(regions(sketchPageRows(read, 297, 210, wider))).toEqual([
      [1, 'body'],
      [1, 'body'],
      [2, 'title_block'],
      [2, 'title_block'],
      [2, 'title_block'],
    ]);
    // The tabs of a sketch read take the box of the read.
    const sheets = (titleBlock?: typeof wider) =>
      pdfDrawingSheets(drawing([page(1)]), null, {
        model: 'm',
        pages: [read],
        pagesPastCap: [],
        ...(titleBlock ? { titleBlock } : {}),
      }).sheets.find((x) => x.name === 'Texts')!;
    const regionCells = (t: ReturnType<typeof sheets>) =>
      t.rows.map((r) => r[t.columns.findIndex((c) => c.name === 'Region')]);
    expect(regionCells(sheets())).toEqual(['body', 'body', 'body', 'body', 'body']);
    expect(regionCells(sheets(wider))).toEqual([
      'body',
      'body',
      'title_block',
      'title_block',
      'title_block',
    ]);
  });

  it('lands in the tabs with Source ocr, and the File and Pages tabs say what was read', () => {
    const d = drawing([page(1), page(2)]);
    const sketch: SketchRead = { model: 'made-up-model', pages: [read], pagesPastCap: [2] };
    const { sheets, description } = pdfDrawingSheets(d, null, sketch);
    const tab = (name: string) => sheets.find((s) => s.name === name)!;
    const cells = (name: string, cols: string[]) => {
      const t = tab(name);
      const at = cols.map((c) => t.columns.findIndex((x) => x.name === c));
      return t.rows.map((r) => at.map((i) => r[i]));
    };
    expect(sheets.map((s) => s.name)).toEqual(['File', 'Pages', 'Texts', 'Tags', 'Lines', 'Gaps']);
    expect(
      cells('File', ['Vision read', 'Vision model', 'Scan pages read', 'Scan pages past the cap']),
    ).toEqual([[true, 'made-up-model', 1, 1]]);
    expect(
      cells('Pages', [
        'Page',
        'Vision status',
        'Pieces',
        'Pieces read',
        'Pieces not sent',
        'Read DPI',
      ]),
    ).toEqual([
      [1, 'ok', 3, 2, 1, 300],
      [2, 'past_page_cap', null, null, null, null],
    ]);
    expect(cells('Texts', ['Text', 'Source', 'Confidence', 'Angle'])[0]).toEqual([
      'FT-101',
      'ocr',
      0.6,
      null,
    ]);
    expect(cells('Tags', ['Tag', 'Source', 'Region'])).toEqual([
      ['FT-101', 'ocr', 'body'],
      ['U2-P-1A', 'ocr', 'body'],
      ['U2-P-1B', 'ocr', 'body'],
    ]);
    expect(cells('Gaps', ['Page', 'Why'])).toEqual([
      [1, 'not_read'],
      [1, 'not_sent'],
    ]);
    expect(description).toMatch(/Source ocr: a vision model \(made-up-model\)/);
  });

  it('the File tab reads back as it was written: the kinds, the decider answer, the vision mark', () => {
    const d = drawing([page(1, { class: 'vector_text', kind: 'unsure' })], 'unsure');
    const decision = {
      kind: 'isometric',
      confidence: 0.91,
      model: 'made-up',
      mode: 'live',
      used: true,
    } as const;
    const sketch: SketchRead = { model: 'made-up-model', pages: [], pagesPastCap: [] };
    for (const [s, vision] of [
      [null, false],
      [sketch, true],
    ] as const) {
      const file = pdfDrawingSheets(d, decision, s).sheets.find((t) => t.name === 'File')!;
      // A checkbox comes back from SQLite as 1 or 0.
      const row = file.rows[0]!.map((v) => (typeof v === 'boolean' ? Number(v) : v));
      expect(
        pdfFileTabOf(
          file.columns.map((c) => c.name),
          row,
        ),
      ).toEqual({
        kind: 'isometric',
        rulesKind: 'unsure',
        decision,
        visionRead: vision,
        notReadWhole: 0,
      });
    }
    expect(pdfFileTabOf(['Tag'], ['P-1'])).toBeNull();
  });

  it('with no sketch read the File tab says so and no vision cell is filled', () => {
    const { sheets, description } = pdfDrawingSheets(drawing([page(1)]), null);
    const file = sheets.find((s) => s.name === 'File')!;
    expect(file.rows[0]![file.columns.findIndex((c) => c.name === 'Vision read')]).toBe(false);
    expect(sheets.map((s) => s.name)).toEqual(['File', 'Pages']);
    expect(description).not.toMatch(/Source ocr/);
  });

  it('gives the text of the scan as markdown: markups first, then the pieces, then what was found', () => {
    const d = drawing([
      page(1, {
        rows: {
          words: [],
          tags: [],
          lines: [],
          markups: [
            {
              kind: 'FreeText',
              text: 'REPLACE  PSV-12',
              author: 'A PERSON',
              box: box(0, 0),
              besideKind: '',
              besideBox: null,
            },
            { kind: 'Line', text: '', author: '', box: box(0, 0), besideKind: '', besideBox: null },
          ],
          account: {
            words: 0,
            tagLike: 0,
            asInstrument: 0,
            asEquipment: 0,
            asLine: 0,
            rejected: 0,
            otherTagTokens: 0,
            fromLists: 0,
            bubbles: 0,
          },
        },
      }),
    ]);
    const text = sketchMarkdown(d, { model: 'm', pages: [read], pagesPastCap: [] });
    expect(text).toBe(
      [
        '## Page 1',
        'Markups:\n- REPLACE PSV-12',
        'Text read from the scan:\nFT-101 4"-P-1001-A1B\nplain words | U2-P-1A/B',
        'Tags: FT-101, U2-P-1A, U2-P-1B',
        'Line numbers: 4"-P-1001-A1B',
      ].join('\n\n'),
    );
    // A read that gave no text is no text.
    const empty = sketchPageRead(pieces(), ['', '']);
    expect(
      sketchMarkdown(drawing([page(1)]), { model: 'm', pages: [empty], pagesPastCap: [] }),
    ).toBe('');
  });
});

describe('the shape the PDF tabs pass', () => {
  it('a drawing database passes pdf-file-v1, with every File column pdfFileTabOf reads', () => {
    const sketch: SketchRead = { model: 'made-up-model', pages: [], pagesPastCap: [] };
    for (const s of [null, sketch]) {
      const tabs = pdfDrawingSheets(drawing([page(1)]), null, s).sheets.map((t) => ({
        name: t.name,
        columns: t.columns.map((c) => c.name),
      }));
      expect(shapesOf(tabs)).toEqual(['pdf-file-v1']);
      for (const t of SHAPES['pdf-file-v1'].tabs) {
        expect(tabs.find((w) => w.name === t.name)?.columns).toEqual(
          expect.arrayContaining([...t.columns]),
        );
      }
    }
  });
});
