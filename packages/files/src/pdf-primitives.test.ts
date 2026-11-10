/**
 * The page primitives reader (pdf-primitives.ts) on PDFs drawn here by hand.
 * Phase 0 of the PDF drawing plan: these tests also record what pdfjs-dist
 * gives and what it does not (letter spacing, hidden text). Every drawing,
 * tag and word below is made up: the repo is public.
 */

import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assemblePdf } from './pdf-fixtures.test-helper';
import {
  PAGE_OUT_OF_RANGE,
  readPagePrimitives,
  readPdfPrimitives,
  type Budgets,
  type PagePrimitives,
} from './pdf-primitives';

type PageSpec = {
  w?: number;
  h?: number;
  content: string;
  rotate?: number;
  /** Extra page dictionary entries (a CropBox, a UserUnit). */
  extra?: string;
  /** Annotation dictionaries, written inline in /Annots. */
  annots?: string[];
  /** Form XObject /Fm0 with this matrix and content, and extra dictionary
   *  entries (an /OC). */
  form?: { matrix: string; content: string; extra?: string };
  /** Full-page image /Im0. */
  image?: boolean;
  /** Extra image dictionary entries (an /OC). */
  imageExtra?: string;
  /** Extra objects, numbered from 6 in order (for annots, OCGs, fonts). */
  more?: string[];
  /** Extra catalog entries (an /OCProperties). */
  catalog?: string;
  /** Extra resource entries (/Properties). */
  resources?: string;
  /** More /Font entries (/F2 6 0 R). */
  fonts?: string;
};

function onePage(spec: PageSpec): Buffer {
  const { w = 400, h = 200, content, rotate = 0, extra = '', annots = [], form, image } = spec;
  const xo: string[] = [];
  const objs: (string | [string, Buffer])[] = [
    `<< /Type /Catalog /Pages 2 0 R ${spec.catalog ?? ''} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '', // the page, set below once the object numbers are known
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...(spec.more ?? []),
  ];
  if (form) {
    objs.push(
      `<< /Type /XObject /Subtype /Form /BBox [-1000 -1000 1000 1000] /Matrix [${form.matrix}] ` +
        `${form.extra ?? ''} /Length ${form.content.length} >>\nstream\n${form.content}\nendstream`,
    );
    xo.push(`/Fm0 ${objs.length} 0 R`);
  }
  if (image) {
    const px = deflateSync(Buffer.alloc(20 * 10 * 3, 230));
    objs.push([
      '<< /Type /XObject /Subtype /Image /Width 20 /Height 10 /ColorSpace /DeviceRGB ' +
        `/BitsPerComponent 8 /Filter /FlateDecode ${spec.imageExtra ?? ''} /Length ${px.length} >>`,
      px,
    ]);
    xo.push(`/Im0 ${objs.length} 0 R`);
  }
  const res =
    `<< /Font << /F1 5 0 R ${spec.fonts ?? ''}>>${xo.length ? ` /XObject << ${xo.join(' ')} >>` : ''} ` +
    `${spec.resources ?? ''} >>`;
  const ann = annots.length ? ` /Annots [${annots.join(' ')}]` : '';
  objs[2] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Rotate ${rotate} ${extra}${ann} ` +
    `/Resources ${res} /Contents 4 0 R >>`;
  return assemblePdf(objs);
}

/** Three pages of the same content (for the file-level time budget). */
function threePages(content: string): Buffer {
  const len = Buffer.byteLength(content, 'latin1');
  const page = (c: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] ` +
    `/Resources << /Font << /F1 3 0 R >> >> /Contents ${c} 0 R >>`;
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [5 0 R 6 0 R 7 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${len} >>\nstream\n${content}\nendstream`,
    page(4),
    page(4),
    page(4),
  ]);
}

async function readOne(pdf: Buffer, budgets?: Budgets) {
  const { pages } = await readPdfPrimitives(pdf, budgets ? { budgets } : {});
  expect(pages).toHaveLength(1);
  return pages[0]!;
}

function ok(p: PagePrimitives) {
  if (p.status !== 'ok') throw new Error(`page status ${p.status}`);
  return p;
}

const near = (got: number, want: number, eps = 0.005) =>
  expect(Math.abs(got - want)).toBeLessThan(eps);

// A 400 x 200 page: a 10 pt tag at (100, 150), a line from (40, 20) to
// (360, 20).
const TAG = 'XQ-V-101';
const PLAIN = `BT /F1 10 Tf 100 150 Td (${TAG}) Tj ET 1 w 40 20 m 360 20 l S`;

describe('the page frame', () => {
  it('puts the origin top left, in fractions of the page', async () => {
    const p = ok(await readOne(onePage({ content: PLAIN })));
    expect(p.widthMm).toBeCloseTo((400 / 72) * 25.4, 3);
    const t = p.texts.find((r) => r.str === TAG)!;
    near(t.box[0], 100 / 400);
    near(t.box[3], 1 - 150 / 200); // the baseline, y down
    expect(t.box[1]).toBeLessThan(t.box[3]); // the top is above the baseline
    expect(t.angle).toBe(0);
    near(t.sizeMm, (10 / 72) * 25.4, 0.01);
    expect(p.segments).toEqual([{ kind: 'L', a: [0.1, 0.9], b: [0.9, 0.9] }]);
  });

  it('applies a page rotation of 90: the shown page is portrait', async () => {
    const p = ok(await readOne(onePage({ content: PLAIN, rotate: 90 })));
    expect(p.rotate).toBe(90);
    expect(p.heightMm).toBeGreaterThan(p.widthMm);
    // /Rotate 90 turns the page clockwise: user (x, y) shows at
    // (y / 200, x / 400) from the top left.
    const s = p.segments[0]!;
    near(s.a[0], 20 / 200);
    near(s.a[1], 40 / 400);
    near(s.b[1], 360 / 400);
    const t = p.texts.find((r) => r.str === TAG)!;
    expect(t.angle).toBe(-90); // the text now runs down the shown page
    near(t.box[1], 100 / 400);
  });

  it('gives the same fractions for a page offset by a CropBox and scaled by UserUnit', async () => {
    // The plain page, drawn 1000 units right and 500 up, cropped back to the
    // same 400 x 200 window, with a UserUnit of 2.
    const shifted = `BT /F1 10 Tf 1100 650 Td (${TAG}) Tj ET 1 w 1040 520 m 1360 520 l S`;
    const plain = ok(await readOne(onePage({ content: PLAIN })));
    const crop = ok(
      await readOne(
        onePage({
          w: 2000,
          h: 1000,
          content: shifted,
          extra: '/CropBox [1000 500 1400 700] /UserUnit 2',
        }),
      ),
    );
    expect(crop.userUnit).toBe(2);
    expect(crop.widthMm).toBeCloseTo(plain.widthMm * 2, 3);
    expect(crop.segments).toEqual(plain.segments);
    const a = plain.texts.find((r) => r.str === TAG)!;
    const b = crop.texts.find((r) => r.str === TAG)!;
    for (let i = 0; i < 4; i++) near(b.box[i]!, a.box[i]!, 1e-4);
    expect(b.sizeMm).toBeCloseTo(a.sizeMm * 2, 2);
  });

  it('reads vertical text (a rotated text matrix) with its angle and a tall box', async () => {
    const p = ok(
      await readOne(onePage({ content: `BT /F1 10 Tf 0 1 -1 0 300 40 Tm (${TAG}) Tj ET` })),
    );
    const t = p.texts.find((r) => r.str === TAG)!;
    expect(t.angle).toBe(90);
    const wide = t.box[2] - t.box[0];
    const tall = (t.box[3] - t.box[1]) * 2; // the page is twice as wide as tall
    expect(tall).toBeGreaterThan(wide * 3);
    near(t.box[2], 300 / 400); // the baseline is the right edge
    near(t.box[3], 1 - 40 / 200);
  });

  it('follows a form XObject matrix and keeps curves', async () => {
    const p = ok(
      await readOne(
        onePage({
          content: 'q /Fm0 Do Q',
          form: { matrix: '2 0 0 2 100 50', content: '0 0 m 10 0 l 10 10 20 10 20 0 c S' },
        }),
      ),
    );
    expect(p.segments).toEqual([
      { kind: 'L', a: [0.25, 0.75], b: [0.3, 0.75] },
      { kind: 'C', a: [0.3, 0.75], b: [0.35, 0.75] },
    ]);
  });

  it('leaves a clip-only path out', async () => {
    const p = ok(await readOne(onePage({ content: `0 0 100 100 re W n ${PLAIN}` })));
    expect(p.segments).toHaveLength(1);
    expect(p.stats.paths).toBe(1);
  });
});

describe('what pdfjs gives for letter-spaced text (plan T2)', () => {
  const read = async (content: string) => ok(await readOne(onePage({ content }))).texts;

  it('wide char spacing (8 Tc at 10 pt): one run per letter, each with its own box', async () => {
    const runs = await read('BT /F1 10 Tf 8 Tc 20 100 Td (SEPARATOR) Tj ET');
    expect(runs.map((r) => r.str)).toEqual('SEPARATOR'.split(''));
    // The gap between letters is readable from the boxes.
    expect((runs[1]!.box[0] - runs[0]!.box[2]) * 400).toBeGreaterThan(5);
  });

  it('medium char spacing (3 Tc): pdfjs puts fake spaces in, one run', async () => {
    // Recorded as found, and it is the T2 fault seen at the site: the
    // spaces are pdfjs's own, and the run cannot tell them from real ones.
    const runs = await read('BT /F1 10 Tf 3 Tc 20 100 Td (SEPARATOR) Tj ET');
    expect(runs.map((r) => r.str)).toEqual(['S E P A R A T O R']);
  });

  it('real spaces in the string give the same run as medium spacing', async () => {
    const runs = await read('BT /F1 10 Tf 20 100 Td (S E P A R A T O R) Tj ET');
    expect(runs.map((r) => r.str)).toEqual(['S E P A R A T O R']);
  });

  it('TJ kerning gaps: one run per letter', async () => {
    const runs = await read('BT /F1 10 Tf 20 100 Td [(S) -800 (E) -800 (P)] TJ ET');
    expect(runs.map((r) => r.str)).toEqual(['S', 'E', 'P']);
  });
});

describe('a scan with a hidden OCR text layer (plan G1)', () => {
  it('counts the hidden glyphs and the image cover; the runs still come through', async () => {
    const p = ok(
      await readOne(
        onePage({
          image: true,
          content: `q 400 0 0 200 0 0 cm /Im0 Do Q BT 3 Tr /F1 10 Tf 50 50 Td (${TAG}) Tj ET`,
        }),
      ),
    );
    expect(p.stats.imageCover).toBe(1);
    expect(p.stats.glyphs).toBe(TAG.length);
    expect(p.stats.hiddenGlyphs).toBe(TAG.length);
    // pdfjs does not mark which run is invisible: the page flag says so.
    expect(p.texts.map((r) => r.str)).toEqual([TAG]);
    expect(p.textMayIncludeHidden).toBe(true);
  });

  it('a visible text page has no hidden glyphs, no image cover, and the flag is false', async () => {
    const p = ok(await readOne(onePage({ content: PLAIN })));
    expect(p.stats.hiddenGlyphs).toBe(0);
    expect(p.stats.imageCover).toBe(0);
    expect(p.textMayIncludeHidden).toBe(false);
  });
});

describe('annotations (plan G18, route M)', () => {
  it('reads a FreeText box with its text and box, and leaves Link out', async () => {
    const p = ok(
      await readOne(
        onePage({
          content: PLAIN,
          rotate: 90,
          annots: [
            '<< /Type /Annot /Subtype /FreeText /Rect [40 20 140 60] /Contents (CML 7) /DA (/Helv 9 Tf 0 g) >>',
            '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] >>',
            '<< /Type /Annot /Subtype /Circle /Rect [200 100 220 120] >>',
          ],
        }),
      ),
    );
    expect(p.annotations.map((a) => a.kind)).toEqual(['FreeText', 'Circle']);
    const box = p.annotations[0]!;
    expect(box.text).toBe('CML 7');
    // In the shown (rotated) frame: user x 40..140 becomes y, user y 20..60 x.
    near(box.box[0], 20 / 200);
    near(box.box[2], 60 / 200);
    near(box.box[1], 40 / 400);
    near(box.box[3], 140 / 400);
  });
});

describe('budgets (plan G7)', () => {
  const many = Array.from({ length: 300 }, (_, i) => `${i % 400} 10 m ${i % 400} 190 l`).join(' ');

  it('a page past the segment budget is stated too large, with no partial rows', async () => {
    const p = await readOne(onePage({ content: `${many} S ${PLAIN}` }), {
      maxSegments: 100,
      maxMs: 30_000,
    });
    expect(p).toMatchObject({ status: 'too_large', reason: 'segments', limit: 100, seen: 301 });
    expect(p).not.toHaveProperty('segments');
    expect(p).not.toHaveProperty('texts');
  });

  it('the same page under the budget is read whole', async () => {
    const p = ok(
      await readOne(onePage({ content: `${many} S` }), { maxSegments: 300, maxMs: 30_000 }),
    );
    expect(p.segments).toHaveLength(300);
  });

  it('a page past the time budget is stated too large', async () => {
    const p = await readOne(onePage({ content: PLAIN }), { maxSegments: 100, maxMs: 0 });
    expect(p).toMatchObject({ status: 'too_large', reason: 'time', limit: 0 });
    expect(p).not.toHaveProperty('texts');
  });
});

describe('pages and faults', () => {
  it('states a page number out of range, and reads a number listed twice once', async () => {
    const { numPages, pages } = await readPdfPrimitives(onePage({ content: PLAIN }), {
      pages: [1, 2, 0, 1, 1.5],
    });
    expect(numPages).toBe(1);
    expect(pages.map((p) => [p.page, p.status])).toEqual([
      [1, 'ok'],
      [2, 'failed'],
      [0, 'failed'],
      [1.5, 'failed'],
    ]);
    for (const p of pages.slice(1)) {
      expect(p).toEqual({ page: p.page, status: 'failed', code: PAGE_OUT_OF_RANGE, ms: 0 });
    }
  });

  it('after the first page over time, later pages are stated too large without a read', async () => {
    const { pages } = await readPdfPrimitives(threePages(PLAIN), {
      budgets: { maxSegments: 100, maxMs: 0 },
    });
    expect(pages).toHaveLength(3);
    // The first page timed out at getPage (it is under the page budget), so
    // it was never opened: no frame is made up for it.
    expect(pages[0]).toMatchObject({ page: 1, status: 'too_large', reason: 'time', limit: 0 });
    expect(pages[0]).not.toHaveProperty('widthMm');
    // The later ones were never opened either.
    for (const [i, p] of pages.slice(1).entries()) {
      expect(p).toEqual({
        page: i + 2,
        status: 'too_large',
        reason: 'time',
        limit: 0,
        seen: 0,
        ms: 0,
      });
    }
  });

  it('a page opened and then over time keeps its frame', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const page = {
      pageNumber: 2,
      rotate: 0,
      userUnit: 1,
      getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      cleanup: () => {},
    } as unknown as Parameters<typeof readPagePrimitives>[1];
    const r = await readPagePrimitives(pdfjs, page, { maxSegments: 100, maxMs: 0 });
    expect(r).toMatchObject({ page: 2, status: 'too_large', reason: 'time', limit: 0 });
    expect(r).toHaveProperty('widthMm');
  });

  it('a page under the budget is read when an earlier one was not over time', async () => {
    const { pageCountMayBeShort, pages } = await readPdfPrimitives(threePages(PLAIN));
    expect(pages.map((p) => p.status)).toEqual(['ok', 'ok', 'ok']);
    // A healthy file: the last page opens, the count is not flagged.
    expect(pageCountMayBeShort).toBe(false);
  });

  it('fails a page with path data it does not know, never a short path', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const fake = (data: number[]) =>
      ({
        pageNumber: 1,
        rotate: 0,
        userUnit: 1,
        getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
        getOperatorList: async () => ({
          fnArray: [pdfjs.OPS.constructPath],
          argsArray: [[pdfjs.OPS.stroke, [new Float32Array(data)], null]],
        }),
        getTextContent: async () => ({ items: [], styles: {} }),
        getAnnotations: async () => [],
        cleanup: () => {},
      }) as unknown as Parameters<typeof readPagePrimitives>[1];
    // An unknown op code (9) after a good line.
    const bad = await readPagePrimitives(pdfjs, fake([0, 0, 0, 1, 10, 10, 9, 1, 1]));
    expect(bad).toMatchObject({ status: 'failed', code: 'BadPath' });
    // Data cut short: a lineTo with one number.
    const cut = await readPagePrimitives(pdfjs, fake([0, 0, 0, 1, 10]));
    expect(cut).toMatchObject({ status: 'failed', code: 'BadPath' });
    // The same walk on good data is ok.
    const good = ok(await readPagePrimitives(pdfjs, fake([0, 0, 0, 1, 10, 10])));
    expect(good.segments).toEqual([{ kind: 'L', a: [0, 1], b: [0.1, 0.9] }]);
  });
});

describe('rotation and transforms', () => {
  // The line of PLAIN runs from user (40, 20) to (360, 20) on a 400 x 200 page.
  it('rotation 180: user (x, y) shows at (1 - x / 400, y / 200)', async () => {
    const p = ok(await readOne(onePage({ content: PLAIN, rotate: 180 })));
    expect(p.widthMm).toBeGreaterThan(p.heightMm);
    expect(p.segments).toEqual([{ kind: 'L', a: [0.9, 0.1], b: [0.1, 0.1] }]);
    const t = p.texts.find((r) => r.str === TAG)!;
    expect(t.angle).toBe(180);
    near(t.box[2], 1 - 100 / 400); // the run starts at x 100 and runs left
    near(t.box[1], 150 / 200); // the baseline, now near the bottom
  });

  it('rotation 270: user (x, y) shows at (1 - y / 200, 1 - x / 400)', async () => {
    const p = ok(await readOne(onePage({ content: PLAIN, rotate: 270 })));
    expect(p.heightMm).toBeGreaterThan(p.widthMm);
    expect(p.segments).toEqual([{ kind: 'L', a: [0.9, 0.9], b: [0.9, 0.1] }]);
    const t = p.texts.find((r) => r.str === TAG)!;
    expect(t.angle).toBe(90);
    near(t.box[3], 1 - 100 / 400);
  });

  it('an outer cm and a second cm around a form XObject apply in PDF order', async () => {
    // Form (0,0) -> matrix (10,10) -> scale 2 (20,20) -> shift 50 (70,20).
    // With the two cm swapped it would land at (120, 20).
    const p = ok(
      await readOne(
        onePage({
          content: 'q 1 0 0 1 50 0 cm 2 0 0 2 0 0 cm /Fm0 Do Q',
          form: { matrix: '1 0 0 1 10 10', content: '0 0 m 10 0 l S' },
        }),
      ),
    );
    expect(p.segments).toEqual([{ kind: 'L', a: [70 / 400, 0.9], b: [90 / 400, 0.9] }]);
  });

  it('a line after q ... cm ... Q is back in the page transform', async () => {
    const p = ok(
      await readOne(onePage({ content: `q 2 0 0 2 0 0 cm 10 10 m 20 10 l S Q ${PLAIN}` })),
    );
    expect(p.segments).toEqual([
      { kind: 'L', a: [0.05, 0.9], b: [0.1, 0.9] },
      { kind: 'L', a: [0.1, 0.9], b: [0.9, 0.9] },
    ]);
  });
});

describe('path closing', () => {
  const segs = async (content: string) => ok(await readOne(onePage({ content }))).segments;

  it('re gives four sides, the last one closing', async () => {
    const s = await segs('100 50 200 100 re S');
    expect(s).toHaveLength(4);
    expect(s[3]).toEqual({ kind: 'L', a: [0.25, 0.25], b: [0.25, 0.75] });
  });

  it('h closes the subpath', async () => {
    const s = await segs('40 20 m 360 20 l 360 180 l h S');
    expect(s).toHaveLength(3);
    expect(s[2]).toEqual({ kind: 'L', a: [0.9, 0.1], b: [0.1, 0.9] });
  });

  it('a fill closes every open subpath', async () => {
    const s = await segs('40 20 m 120 20 l 120 100 l 200 20 m 280 20 l 280 100 l f');
    expect(s).toHaveLength(6);
    expect(s[2]).toEqual({ kind: 'L', a: [0.3, 0.5], b: [0.1, 0.9] });
    expect(s[5]).toEqual({ kind: 'L', a: [0.7, 0.5], b: [0.5, 0.9] });
  });

  it('a stroke does not close', async () => {
    expect(await segs('40 20 m 120 20 l 120 100 l S')).toHaveLength(2);
  });

  it('a line with no current point makes no segment from the origin', async () => {
    const s = await segs('120 100 l 200 100 l S');
    expect(s).toEqual([{ kind: 'L', a: [0.3, 0.5], b: [0.5, 0.5] }]);
  });
});

describe('content that is never shown', () => {
  it('annotation appearance streams add no segments (Stamp and Square)', async () => {
    // Appearance streams with their own /BBox, at a /Rect far from the
    // origin. With annotations on in the operator list, their lines would
    // land at the wrong place on the page.
    const draw = '0 0 m 50 50 l S';
    const ap = `<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] /Length ${draw.length} >>\nstream\n${draw}\nendstream`;
    const p = ok(
      await readOne(
        onePage({
          content: PLAIN,
          more: [ap, ap],
          annots: [
            '<< /Type /Annot /Subtype /Stamp /Rect [300 100 350 150] /AP << /N 6 0 R >> >>',
            '<< /Type /Annot /Subtype /Square /Rect [200 120 250 170] /AP << /N 7 0 R >> >>',
          ],
        }),
      ),
    );
    expect(p.segments).toEqual([{ kind: 'L', a: [0.1, 0.9], b: [0.9, 0.9] }]);
    expect(p.annotations.map((a) => a.kind)).toEqual(['Stamp', 'Square']);
  });

  it('leaves out paths in an optional content group that is off, and counts them', async () => {
    const p = ok(
      await readOne(
        onePage({
          content:
            `/OC /oc1 BDC 0 0 m 100 100 l S BT /F1 10 Tf 20 20 Td (HID) Tj ET EMC ` +
            `/OC /oc2 BDC 0 100 m 100 100 l S EMC ${PLAIN}`,
          more: ['<< /Type /OCG /Name (Off) >>', '<< /Type /OCG /Name (On) >>'],
          catalog: '/OCProperties << /OCGs [6 0 R 7 0 R] /D << /OFF [6 0 R] >> >>',
          resources: '/Properties << /oc1 6 0 R /oc2 7 0 R >>',
        }),
      ),
    );
    expect(p.segments).toEqual([
      { kind: 'L', a: [0, 0.5], b: [0.25, 0.5] },
      { kind: 'L', a: [0.1, 0.9], b: [0.9, 0.9] },
    ]);
    expect(p.stats.ocHiddenSegments).toBe(1);
    expect(p.stats.ocHiddenGlyphs).toBe(3);
    expect(p.stats.paths).toBe(2);
    // pdfjs's text content does not name the group: the run still comes
    // through, and the count and the page flag say so.
    expect(p.texts.map((t) => t.str)).toContain('HID');
    expect(p.stats.hiddenGlyphs).toBe(0);
    expect(p.textMayIncludeHidden).toBe(true);
  });

  it('leaves out Hidden and NoView annotations, and counts them', async () => {
    const p = ok(
      await readOne(
        onePage({
          content: PLAIN,
          annots: [
            '<< /Type /Annot /Subtype /FreeText /Rect [40 20 140 60] /Contents (A) /F 2 >>',
            '<< /Type /Annot /Subtype /FreeText /Rect [40 20 140 60] /Contents (B) /F 32 >>',
            '<< /Type /Annot /Subtype /FreeText /Rect [40 20 140 60] /Contents (C) /F 4 >>',
          ],
        }),
      ),
    );
    expect(p.annotations.map((a) => a.text)).toEqual(['C']);
    expect(p.stats.hiddenAnnotations).toBe(2);
  });

  it('counts segments and annotations wholly outside the shown page, and keeps them', async () => {
    const p = ok(
      await readOne(
        onePage({
          content: `${PLAIN} 500 20 m 600 20 l S BT /F1 10 Tf -200 50 Td (OUT) Tj ET`,
          annots: ['<< /Type /Annot /Subtype /Circle /Rect [450 250 470 270] >>'],
        }),
      ),
    );
    expect(p.segments).toHaveLength(2);
    expect(p.annotations).toHaveLength(1);
    expect(p.stats.outsideFrame).toEqual({ segments: 1, annotations: 1 });
    // Recorded as found: pdfjs's text content leaves out a run placed
    // outside the page, so it never comes through.
    expect(p.texts.map((t) => t.str)).toEqual([TAG]);
  });
});

describe('fonts and form fields', () => {
  it('counts text runs in a vertical writing-mode font', async () => {
    const p = ok(
      await readOne(
        onePage({
          content: `BT /F2 10 Tf 200 150 Td <00410042> Tj ET ${PLAIN}`,
          more: [
            '<< /Type /Font /Subtype /Type0 /BaseFont /MadeUpMincho /Encoding /Identity-V ' +
              '/DescendantFonts [7 0 R] >>',
            '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MadeUpMincho ' +
              '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
              '/FontDescriptor 8 0 R /DW 1000 >>',
            '<< /Type /FontDescriptor /FontName /MadeUpMincho /Flags 4 ' +
              '/FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 ' +
              '/CapHeight 700 /StemV 80 >>',
          ],
          fonts: '/F2 6 0 R',
        }),
      ),
    );
    expect(p.stats.verticalRuns).toBeGreaterThan(0);
    expect(p.stats.verticalRuns).toBeLessThan(p.texts.length);
  });

  it('joins the values of a multi-value field with a line break', async () => {
    const p = ok(
      await readOne(
        onePage({
          content: PLAIN,
          annots: [
            '<< /Type /Annot /Subtype /Widget /FT /Ch /T (pick) /Ff 2097152 ' +
              '/Opt [(AB) (CD) (EF)] /V [(AB) (CD)] /Rect [40 20 140 60] >>',
          ],
        }),
      ),
    );
    expect(p.annotations).toHaveLength(1);
    expect(p.annotations[0]!.text).toBe('AB\nCD');
  });
});

describe('optional content, more shapes', () => {
  // Object 6 is a group that is off, object 7 one that is on.
  const groups = {
    more: ['<< /Type /OCG /Name (Off) >>', '<< /Type /OCG /Name (On) >>'],
    catalog: '/OCProperties << /OCGs [6 0 R 7 0 R] /D << /OFF [6 0 R] >> >>',
  };
  const LINE = '0 100 m 100 100 l S';

  it('nested groups: content is hidden when any open group is off', async () => {
    const p = ok(
      await readOne(
        onePage({
          ...groups,
          resources: '/Properties << /off 6 0 R /on 7 0 R >>',
          content:
            `/OC /off BDC /OC /on BDC ${LINE} EMC EMC ` +
            `/OC /on BDC /OC /off BDC ${LINE} EMC ${LINE} EMC ${PLAIN}`,
        }),
      ),
    );
    expect(p.stats.ocHiddenSegments).toBe(2);
    // The line between the two EMC is in the group that is on only.
    expect(p.segments).toEqual([
      { kind: 'L', a: [0, 0.5], b: [0.25, 0.5] },
      { kind: 'L', a: [0.1, 0.9], b: [0.9, 0.9] },
    ]);
  });

  it('an OCMD with a /VE expression: And of off and on is hidden, Or is shown', async () => {
    const p = ok(
      await readOne(
        onePage({
          more: [
            ...groups.more,
            '<< /Type /OCMD /OCGs [6 0 R 7 0 R] /VE [/And 6 0 R 7 0 R] >>',
            '<< /Type /OCMD /OCGs [6 0 R 7 0 R] /VE [/Or 6 0 R 7 0 R] >>',
          ],
          catalog: groups.catalog,
          resources: '/Properties << /and 8 0 R /or 9 0 R >>',
          content: `/OC /and BDC 0 0 m 100 100 l S EMC /OC /or BDC ${LINE} EMC`,
        }),
      ),
    );
    expect(p.stats.ocHiddenSegments).toBe(1);
    expect(p.segments).toEqual([{ kind: 'L', a: [0, 0.5], b: [0.25, 0.5] }]);
  });

  it('a form XObject with its own /OC on a group that is off adds no segments', async () => {
    const p = ok(
      await readOne(
        onePage({
          ...groups,
          content: `/Fm0 Do ${PLAIN}`,
          form: { matrix: '1 0 0 1 0 0', content: LINE, extra: '/OC 6 0 R' },
        }),
      ),
    );
    expect(p.stats.ocHiddenSegments).toBe(1);
    expect(p.segments).toEqual([{ kind: 'L', a: [0.1, 0.9], b: [0.9, 0.9] }]);
  });

  it('an image with its own /OC on a group that is off: counted, no cover', async () => {
    const p = ok(
      await readOne(
        onePage({
          ...groups,
          image: true,
          imageExtra: '/OC 6 0 R',
          content: `q 400 0 0 200 0 0 cm /Im0 Do Q ${PLAIN}`,
        }),
      ),
    );
    expect(p.stats.ocHiddenImages).toBe(1);
    expect(p.stats.imageCover).toBe(0);
  });

  it('an image in marked content that is off is counted in ocHiddenImages', async () => {
    const p = ok(
      await readOne(
        onePage({
          ...groups,
          image: true,
          resources: '/Properties << /off 6 0 R >>',
          content: `/OC /off BDC q 400 0 0 200 0 0 cm /Im0 Do Q EMC`,
        }),
      ),
    );
    expect(p.stats.ocHiddenImages).toBe(1);
    expect(p.stats.imageCover).toBe(0);
  });

  it('an annotation with /OC on a group that is off is left out and counted', async () => {
    const p = ok(
      await readOne(
        onePage({
          ...groups,
          content: PLAIN,
          annots: [
            '<< /Type /Annot /Subtype /FreeText /Rect [40 20 140 60] /Contents (OFF) /OC 6 0 R >>',
            '<< /Type /Annot /Subtype /FreeText /Rect [40 20 140 60] /Contents (ON) /OC 7 0 R >>',
          ],
        }),
      ),
    );
    expect(p.annotations.map((a) => a.text)).toEqual(['ON']);
    expect(p.stats.hiddenAnnotations).toBe(1);
  });
});

describe('form XObject state', () => {
  it('a stray Q inside a form does not pop the outer transform', async () => {
    const p = ok(
      await readOne(
        onePage({
          content: 'q 1 0 0 1 100 0 cm /Fm0 Do 50 50 m 60 60 l S Q',
          form: { matrix: '1 0 0 1 0 0', content: 'Q 0 0 m 1 1 l S' },
        }),
      ),
    );
    // The page line is at user (150, 50) to (160, 60).
    expect(p.segments.at(-1)).toEqual({ kind: 'L', a: [0.375, 0.75], b: [0.4, 0.7] });
    // The form line keeps the outer cm too: user (100, 0) to (101, 1).
    expect(p.segments[0]).toEqual({ kind: 'L', a: [0.25, 1], b: [0.2525, 0.995] });
  });
});

describe('drawn content the walk does not follow', () => {
  it('counts a shading fill, a tiling pattern and Type3 text in notWalked', async () => {
    const cell = '0 0 m 10 10 l S';
    const glyph = '1000 0 0 0 1000 1000 d1 0 0 m 1000 1000 l S';
    const p = ok(
      await readOne(
        onePage({
          content:
            'q 0 0 100 100 re W n /Sh0 sh Q ' +
            '/Pattern cs /P0 scn 200 0 100 100 re f ' +
            'BT /F2 10 Tf 50 150 Td (A) Tj ET',
          more: [
            '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] ' +
              '/Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >>',
            '<< /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 ' +
              `/YStep 10 /Resources << >> /Length ${cell.length} >>\nstream\n${cell}\nendstream`,
            '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] ' +
              '/FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 9 0 R >> ' +
              '/Encoding << /Type /Encoding /Differences [65 /a] >> ' +
              '/FirstChar 65 /LastChar 65 /Widths [1000] /Resources << >> >>',
            `<< /Length ${glyph.length} >>\nstream\n${glyph}\nendstream`,
          ],
          resources: '/Shading << /Sh0 6 0 R >> /Pattern << /P0 7 0 R >>',
          fonts: '/F2 8 0 R',
        }),
      ),
    );
    expect(p.stats.notWalked).toBe(3);
    // The filled rectangle's own outline is walked.
    expect(p.segments).toHaveLength(4);
  });

  it('a plain page has nothing not walked', async () => {
    const p = ok(await readOne(onePage({ content: PLAIN })));
    expect(p.stats.notWalked).toBe(0);
  });
});

describe('image ops that paint at many places', () => {
  const fakePage = (pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs'), args: unknown[]) =>
    ({
      pageNumber: 1,
      rotate: 0,
      userUnit: 1,
      getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
      getOperatorList: async () => ({
        fnArray: [pdfjs.OPS.paintImageXObjectRepeat],
        argsArray: [args],
      }),
      getTextContent: async () => ({ items: [], styles: {} }),
      getAnnotations: async () => [],
      cleanup: () => {},
    }) as unknown as Parameters<typeof readPagePrimitives>[1];

  it('paintImageXObjectRepeat counts each place at its own transform', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // Two 10 x 10 images, at (0, 0) and at (50, 50). Counted once at the plain
    // transform, the cover would be 0 (one unit square).
    const p = ok(await readPagePrimitives(pdfjs, fakePage(pdfjs, ['img', 10, 10, [0, 0, 50, 50]])));
    expect(p.stats.imageCover).toBe(0.02);
    const bad = await readPagePrimitives(pdfjs, fakePage(pdfjs, ['img', 10, 10, [0, 0, 95]]));
    expect(bad).toMatchObject({ status: 'failed', code: 'BadPath' });
  });
});

describe('file budget and page faults', () => {
  it('a file over maxFileMs states every later page too large, not read', async () => {
    const { pages } = await readPdfPrimitives(threePages(PLAIN), {
      budgets: { maxSegments: 100, maxMs: 30_000, maxFileMs: 0 },
    });
    expect(pages).toHaveLength(3);
    for (const [i, p] of pages.entries()) {
      expect(p).toMatchObject({ page: i + 1, status: 'too_large', reason: 'time', limit: 0 });
      expect(p).not.toHaveProperty('widthMm');
    }
  });

  it('a getPage that throws fails that page only; the others come back', async () => {
    const len = Buffer.byteLength(PLAIN, 'latin1');
    const page = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>`;
    const tree = (kids: string, count: number) =>
      assemblePdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${len} >>\nstream\n${PLAIN}\nendstream`,
        page,
        '42', // a page tree kid that is not a page
        page,
      ]);
    // The bad kid last; it is read first, and the good pages after it.
    const last = await readPdfPrimitives(tree('5 0 R 7 0 R 6 0 R', 3), {
      pages: [3, 1, 2],
    });
    const { numPages, pages } = last;
    expect(numPages).toBe(3);
    // The last page fails at getPage, so the flag is set. Here the count is
    // right (the bad kid is last); the flag says only that it may be short.
    expect(last.pageCountMayBeShort).toBe(true);
    expect(pages.map((p) => [p.page, p.status])).toEqual([
      [3, 'failed'],
      [1, 'ok'],
      [2, 'ok'],
    ]);
    expect(pages[0]).toEqual({
      page: 3,
      status: 'failed',
      code: 'UnknownErrorException',
      ms: expect.any(Number),
    });
    // With the bad kid in the middle, pdfjs cuts the page count at it: the
    // page after it gets no result. The bad kid is then the last page, so
    // the flag says the count may be short.
    const mid = await readPdfPrimitives(tree('5 0 R 6 0 R 7 0 R', 3));
    expect(mid.numPages).toBe(2);
    expect(mid.pages.map((p) => p.status)).toEqual(['ok', 'failed']);
    expect(mid.pageCountMayBeShort).toBe(true);
    // The flag is the same when only the first page is asked for.
    const first = await readPdfPrimitives(tree('5 0 R 6 0 R 7 0 R', 3), { pages: [1] });
    expect(first.pages.map((p) => p.status)).toEqual(['ok']);
    expect(first.pageCountMayBeShort).toBe(true);
  });

  it('a getViewport that throws fails the page, it does not throw', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const page = {
      pageNumber: 4,
      getViewport: () => {
        throw new Error('made up');
      },
      cleanup: () => {},
    } as unknown as Parameters<typeof readPagePrimitives>[1];
    const r = await readPagePrimitives(pdfjs, page);
    expect(r).toMatchObject({ page: 4, status: 'failed', code: 'other' });
    expect(r).not.toHaveProperty('widthMm');
  });
});
