import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AXIS_MIN_MM,
  AXIS_TOLERANCE_DEG,
  axisOf,
  axisShares,
  bubblePairs,
  fileKindOf,
  kindSample,
  pageClassOf,
  pageFacts,
  pageKindOf,
  pageSizeOf,
  type PageEye,
  type PageFacts,
} from './pdf-kind';
import type { PagePrimitives, PageStats, Segment, TextRun } from './pdf-primitives';

const STATS: PageStats = {
  glyphs: 100,
  hiddenGlyphs: 0,
  imageCover: 0,
  paths: 0,
  ocHiddenSegments: 0,
  ocHiddenImages: 0,
  ocHiddenGlyphs: 0,
  hiddenAnnotations: 0,
  notWalked: 0,
  verticalRuns: 0,
  textCheck: { own: 0, pdfjs: 0 },
  outsideFrame: { segments: 0, annotations: 0, texts: 0 },
  ms: 1,
};

/** A text run on a 1000 x 500 mm page: x and y in millimetres, 3 mm text. */
function run(str: string, xMm: number, yMm: number, angle = 0): TextRun {
  const w = (str.length * 2) / 1000;
  const h = 3 / 500;
  const x = xMm / 1000;
  const y = yMm / 500;
  const box: [number, number, number, number] = [x, y - h, x + w, y];
  return {
    str,
    box,
    angle,
    sizeMm: 3,
    font: 'f',
    hidden: false,
    words: str.split(' ').map((word) => ({ str: word, box, hidden: false, spaced: false })),
  };
}

/** `n` lines of `lenMm` at `deg`, on a 1000 x 500 mm page. */
function lines(n: number, lenMm: number, deg: number): Segment[] {
  const rad = (deg * Math.PI) / 180;
  const dx = (Math.cos(rad) * lenMm) / 1000;
  const dy = (-Math.sin(rad) * lenMm) / 500;
  return Array.from({ length: n }, () => ({
    kind: 'L' as const,
    a: [0.5, 0.5] as [number, number],
    b: [0.5 + dx, 0.5 + dy] as [number, number],
    w: 0.25,
    c: '#000000',
    d: false,
  }));
}

function page(over: Partial<Extract<PagePrimitives, { status: 'ok' }>> = {}): PagePrimitives {
  return {
    page: 1,
    widthMm: 1000,
    heightMm: 500,
    rotate: 0,
    userUnit: 1,
    status: 'ok',
    textMayIncludeHidden: false,
    texts: [],
    segments: [],
    annotations: [],
    stats: STATS,
    ...over,
  };
}

describe('page size and class', () => {
  it('names the sheet by its long side', () => {
    expect(pageSizeOf(210, 297)).toBe('a4');
    expect(pageSizeOf(420, 297)).toBe('a3');
    expect(pageSizeOf(594, 420)).toBe('a2');
    expect(pageSizeOf(841, 594)).toBe('a1');
    expect(pageSizeOf(1189, 841)).toBe('a0');
    expect(pageSizeOf(5080, 900)).toBe('larger');
  });

  it('classes a page from four counts', () => {
    const c = (chars: number, segments: number, imageCover = 0, hiddenShare = 0) =>
      pageClassOf({ chars, segments, imageCover, hiddenShare });
    expect(c(5000, 20)).toBe('text');
    expect(c(0, 20)).toBe('blank');
    expect(c(5000, 20_000)).toBe('vector_text');
    expect(c(5, 20_000)).toBe('vector_no_text');
    expect(c(0, 0, 1)).toBe('scan');
    expect(c(600, 50, 1, 1)).toBe('scan_hidden_text');
    expect(c(40, 100, 1, 0.2)).toBe('raster_with_text');
  });
});

describe('axes', () => {
  it('puts an angle in its axis family, within the tolerance', () => {
    expect(axisOf(0)).toBe('h');
    expect(axisOf(179)).toBe('h');
    expect(axisOf(-90)).toBe('v');
    expect(axisOf(30)).toBe('iso');
    expect(axisOf(152)).toBe('iso');
    expect(axisOf(210)).toBe('iso');
    expect(axisOf(45)).toBe('other');
    expect(axisOf(34)).toBe('other');
  });

  it('shares line length by axis, on paper, and leaves short lines out', () => {
    const a = axisShares(
      [...lines(6, 100, 0), ...lines(2, 100, 90), ...lines(2, 100, 30), ...lines(50, 2, 45)],
      1000,
      500,
    );
    expect(a).toEqual({ h: 0.6, v: 0.2, iso: 0.2, other: 0, longMm: 1000 });
  });

  it('the picture reader in the parser judges by the same two numbers', () => {
    // One rule for a drawn page (here) and a raster page (pdf_eye.py).
    const py = readFileSync(
      path.resolve(import.meta.dirname, '../../../server/parser/cad/pdf_eye.py'),
      'utf8',
    );
    const value = (name: string) => Number(new RegExp(`^${name} = ([0-9.]+)$`, 'm').exec(py)?.[1]);
    expect(value('AXIS_MIN_MM')).toBe(AXIS_MIN_MM);
    expect(value('AXIS_TOLERANCE_DEG')).toBe(AXIS_TOLERANCE_DEG);
  });

  it('a curve and an empty page give no axes', () => {
    const curve: Segment = { kind: 'C', a: [0, 0], b: [1, 1], w: 0.25, c: '', d: false };
    expect(axisShares([curve], 1000, 500)).toEqual({ h: 0, v: 0, iso: 0, other: 0, longMm: 0 });
  });
});

describe('bubblePairs', () => {
  it('pairs a code with the number under it, and not one beside it', () => {
    const code = run('FIC', 100, 100);
    const under = run('101', 100, 105);
    const beside = run('202', 130, 100);
    const far = run('303', 100, 140);
    expect(bubblePairs([code, under, beside, far], 1000, 500)).toEqual([{ code, number: under }]);
  });

  it('pairs on a turned sheet: "under" follows the text', () => {
    // Text reading up the page: under it is to its right.
    const code: TextRun = { ...run('PT', 0, 0, 90), box: [0.1, 0.19, 0.103, 0.2] };
    const under: TextRun = { ...run('12', 0, 0, 90), box: [0.105, 0.19, 0.108, 0.2] };
    const left: TextRun = { ...run('34', 0, 0, 90), box: [0.095, 0.19, 0.098, 0.2] };
    expect(bubblePairs([code, under, left], 1000, 500)).toEqual([{ code, number: under }]);
  });

  it('pairs across the wrap at 180 degrees: 179.5 and -179.8 are 0.7 apart', () => {
    // Text upside down: under it is up the page.
    const code: TextRun = { ...run('PT', 0, 0, 179.5), box: [0.1, 0.2, 0.104, 0.206] };
    const under: TextRun = { ...run('12', 0, 0, -179.8), box: [0.1, 0.19, 0.104, 0.196] };
    expect(bubblePairs([code, under], 1000, 500)).toEqual([{ code, number: under }]);
  });

  it('a word that is no ISA code pairs with nothing, and one number serves one code', () => {
    const number = run('101', 100, 105);
    expect(bubblePairs([run('TANK', 100, 100), number], 1000, 500)).toEqual([]);
    const a = run('FT', 100, 100);
    const b = run('FT', 100, 100.5);
    expect(bubblePairs([a, b, number], 1000, 500)).toHaveLength(1);
  });
});

describe('bubblePairs, on a page with more runs than it looks at', () => {
  it('pairs nothing and says so, and the page states it', () => {
    const texts = [run('FIC', 100, 100), run('101', 100, 105), run('PT', 300, 100)];
    // Two codes and one number: two pairs to look at.
    expect(bubblePairs(texts, 1000, 500, 2)).toHaveLength(1);
    expect(bubblePairs(texts, 1000, 500, 1)).toBeNull();
    // Under the budget a page has no note.
    expect(pageFacts(page({ texts })).notes).toBeUndefined();
  });

  it('a page of code and number runs past the budget is not paired: no long loop', () => {
    // 5,000 codes and 5,000 numbers: 25 million pairs, over the budget.
    const texts = Array.from({ length: 10_000 }, (_, i) =>
      run(i % 2 ? 'PT' : '12', (i % 100) * 9, Math.floor(i / 100) * 4),
    );
    const t0 = Date.now();
    const f = pageFacts(page({ texts }));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(f.notes).toEqual(['bubbles_not_paired']);
    expect(f.instruments).toBe(0);
  });
});

describe('pageFacts', () => {
  it('counts tags, bubbles, line numbers and markups', () => {
    const f = pageFacts(
      page({
        texts: [
          run('FIC-101 feeds E-201', 10, 10),
          run('4"-P-1001-A1B', 10, 20),
          run('PT', 300, 100),
          run('102', 300, 105),
        ],
        segments: lines(1500, 20, 0),
        annotations: [
          { kind: 'FreeText', text: 'check weld', box: [0, 0, 0.1, 0.1], author: '' },
          { kind: 'Line', text: '', box: [0, 0, 0.1, 0.1], author: '' },
          { kind: 'Widget', text: 'x', box: [0, 0, 0.1, 0.1], author: '' },
        ],
      }),
    );
    expect(f).toMatchObject({
      status: 'ok',
      size: 'a0',
      class: 'vector_text',
      runs: 4,
      segments: 1500,
      tagLike: 2, // FIC-101, E-201 (the line number holds a quote)
      instruments: 2, // FIC-101 and the PT bubble
      lineNumbers: 1,
      markups: 2,
      markupsWithText: 1,
    });
    expect(f.axes?.h).toBe(1);
  });

  it('a page over the path budget keeps its text facts, with no axes', () => {
    const f = pageFacts({
      page: 3,
      widthMm: 1000,
      heightMm: 500,
      rotate: 0,
      userUnit: 1,
      status: 'too_large',
      reason: 'segments',
      limit: 250_000,
      seen: 900_000,
      ms: 5,
      textMayIncludeHidden: false,
      texts: [run('FIC-101 and more text here', 10, 10)],
      annotations: [],
      stats: STATS,
    });
    expect(f).toMatchObject({
      page: 3,
      status: 'too_large',
      why: 'segments',
      class: 'vector_text',
      segments: 900_000,
      instruments: 1,
      axes: null,
    });
  });

  it('a page that was not read has a status and no class', () => {
    expect(pageFacts({ page: 2, status: 'failed', code: 'FormatError', ms: 1 })).toMatchObject({
      page: 2,
      status: 'failed',
      why: 'FormatError',
      chars: 0,
    });
    const late = pageFacts({
      page: 4,
      status: 'too_large',
      reason: 'time',
      limit: 1,
      seen: 0,
      ms: 0,
    });
    expect(late).toMatchObject({ status: 'too_large', why: 'time' });
    expect(late.class).toBeUndefined();
    expect(pageKindOf(late)).toBe('none');
  });
});

describe('kinds', () => {
  const facts = (over: Partial<PageFacts>): PageFacts => ({
    page: 1,
    status: 'ok',
    widthMm: 1189,
    heightMm: 841,
    size: 'a0',
    class: 'vector_text',
    chars: 5000,
    runs: 900,
    hiddenShare: 0,
    imageCover: 0,
    segments: 20_000,
    axes: { h: 0.6, v: 0.3, iso: 0.01, other: 0.09, longMm: 60_000 },
    tagLike: 60,
    instruments: 0,
    lineNumbers: 0,
    markups: 0,
    markupsWithText: 0,
    readMs: 5,
    ...over,
  });
  const eye = (over: Partial<PageEye['axes']>): PageEye => ({
    axes: { h: 0.6, v: 0.3, iso: 0.03, other: 0.07, longMm: 8000, ...over },
    skewDeg: 0,
    ink: 0.05,
    textAreas: 300,
  });
  const a4 = { widthMm: 297, heightMm: 210, size: 'a4' as const };

  it('a large drawn page with line numbers, or with many instrument tags, is a P&ID', () => {
    expect(pageKindOf(facts({ lineNumbers: 3 }))).toBe('pid');
    expect(pageKindOf(facts({ instruments: 60 }))).toBe('pid');
    expect(pageKindOf(facts({ lineNumbers: 2, instruments: 42 }))).toBe('unsure');
    // The same counts on an A4 sheet: a form or a list, not a P&ID by rule.
    expect(pageKindOf(facts({ ...a4, lineNumbers: 30 }))).toBe('unsure');
  });

  it('a typed office page is a document; a large near-empty sheet is unsure', () => {
    expect(pageKindOf(facts({ ...a4, class: 'text' }))).toBe('document');
    expect(pageKindOf(facts({ ...a4, class: 'blank' }))).toBe('document');
    expect(pageKindOf(facts({ class: 'text' }))).toBe('unsure');
  });

  it('a drawn page with no text layer is a drawing; isometric when the axes are clear', () => {
    const noText = facts({ ...a4, class: 'vector_no_text', chars: 0 });
    expect(pageKindOf(noText)).toBe('other_drawing');
    // On an office sheet it needs the long lines of a drawing: a typed page
    // whose letters are outlines is drawn too, and is all short curves.
    const outlines = { h: 0.5, v: 0.5, iso: 0, other: 0, longMm: 300 };
    expect(pageKindOf({ ...noText, axes: outlines })).toBe('unsure');
    expect(pageKindOf({ ...noText, axes: { ...outlines, longMm: 1999 } })).toBe('unsure');
    expect(pageKindOf({ ...noText, axes: { ...outlines, longMm: 2000 } })).toBe('other_drawing');
    // Two A4 sheets of paper (an A3 sheet) need twice the length.
    const a3 = { widthMm: 420, heightMm: 297, size: 'a3' as const };
    expect(pageKindOf({ ...noText, ...a3, axes: { ...outlines, longMm: 3900 } })).toBe('unsure');
    expect(pageKindOf({ ...noText, ...a3, axes: { ...outlines, longMm: 4100 } })).toBe(
      'other_drawing',
    );
    // A larger sheet is a drawing whatever its lines, and so is a page over
    // the path budget (no axes).
    expect(pageKindOf(facts({ class: 'vector_no_text', chars: 0, axes: outlines }))).toBe(
      'other_drawing',
    );
    expect(pageKindOf({ ...noText, axes: null })).toBe('other_drawing');
    expect(
      pageKindOf({ ...noText, axes: { h: 0.5, v: 0.3, iso: 0.15, other: 0.05, longMm: 5000 } }),
    ).toBe('isometric');
    // Slanted lines, but more of them off the isometric axes than on.
    expect(
      pageKindOf({ ...noText, axes: { h: 0.4, v: 0.2, iso: 0.15, other: 0.25, longMm: 5000 } }),
    ).toBe('other_drawing');
  });

  it('a raster page needs the eye', () => {
    const scan = facts({ ...a4, class: 'scan', chars: 0, segments: 0, axes: null, imageCover: 1 });
    expect(pageKindOf(scan)).toBe('unsure');
    expect(pageKindOf(scan, null, 'scan')).toBe('scan');
    // A scan on a large sheet is a drawing with no picture at all, and the
    // other pages cannot make it a document.
    const a1 = { ...scan, widthMm: 841, heightMm: 594, size: 'a1' as const };
    expect(pageKindOf(a1)).toBe('scan');
    expect(pageKindOf(a1, null, 'document')).toBe('scan');
    expect(pageKindOf(scan, null, 'document')).toBe('document');
    expect(pageKindOf(scan, eye({}))).toBe('scan');
    expect(pageKindOf(scan, eye({ iso: 0.17, other: 0.04 }))).toBe('isometric');
    // Few long lines for the paper: a typed page that was scanned.
    expect(pageKindOf(scan, eye({ longMm: 300 }))).toBe('document');
    // The line floor grows with the paper: 3,000 mm is enough on A4 paper
    // and too little on an A3 sheet, which is two of them.
    expect(pageKindOf(scan, eye({ longMm: 3000 }))).toBe('scan');
    const a3 = { ...scan, widthMm: 420, heightMm: 297, size: 'a3' as const };
    expect(pageKindOf(a3, eye({ longMm: 3000 }))).toBe('document');
    // A picture on a large sheet is a drawing, whatever its lines.
    expect(
      pageKindOf({ ...scan, widthMm: 1189, heightMm: 841, size: 'a0' }, eye({ longMm: 300 })),
    ).toBe('scan');
  });

  it('one drawing page makes the file a drawing', () => {
    expect(fileKindOf(['document', 'document', 'pid'], true)).toBe('pid');
    expect(fileKindOf(['document', 'scan', 'isometric'], true)).toBe('isometric');
    expect(fileKindOf(['document', 'unsure'], true)).toBe('unsure');
    expect(fileKindOf(['none'], false)).toBe('unsure');
    expect(fileKindOf([], true)).toBe('unsure');
  });

  it('a file is a document only when the reader left nothing out', () => {
    expect(fileKindOf(['document', 'document'], true)).toBe('document');
    // What was left out may be the drawing: a page not read, a page with no
    // row, an image too large to open. The caller holds that as one fact.
    expect(fileKindOf(['document', 'document'], false)).toBe('unsure');
    expect(fileKindOf(['document', 'none'], false)).toBe('unsure');
    // A drawing page still names the file.
    expect(fileKindOf(['document', 'none', 'scan'], false)).toBe('scan');
    expect(fileKindOf(['document', 'pid'], false)).toBe('pid');
  });

  it('a page that reads as empty while it draws content the reader does not follow is unsure', () => {
    const blank = facts({ ...a4, class: 'blank', chars: 0, segments: 0 });
    expect(pageKindOf(blank)).toBe('document');
    expect(pageKindOf({ ...blank, notes: ['drawn_content_not_read'] })).toBe('unsure');
    // A typed page keeps its kind: its text was read.
    expect(pageKindOf(facts({ ...a4, class: 'text', notes: ['drawn_content_not_read'] }))).toBe(
      'document',
    );
    // The note comes from the page reader's count.
    expect(pageFacts(page({ stats: { ...STATS, notWalked: 2 } })).notes).toEqual([
      'drawn_content_not_read',
    ]);
  });
});

describe('kindSample', () => {
  it('takes the lower right corner first, then the most used words', () => {
    const texts = [
      run('VALVE VALVE VALVE PUMP PUMP 12 x', 100, 100),
      run('UNIT 7  COOLING  WATER', 900, 450),
      run('SHEET 1 OF 3', 900, 460),
    ];
    expect(kindSample(texts)).toBe(
      'UNIT 7 COOLING WATER SHEET 1 OF 3 VALVE PUMP COOLING SHEET UNIT WATER',
    );
  });

  it('never passes its cap, and is the same on every read', () => {
    const texts = Array.from({ length: 400 }, (_, i) =>
      run(`WORD${'ABCDEFGHIJ'[i % 10]} LONGTEXT${i}`, 900, 450),
    );
    const s = kindSample(texts, 200);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s.length).toBeGreaterThan(150);
    expect(kindSample(texts, 200)).toBe(s);
  });
});
