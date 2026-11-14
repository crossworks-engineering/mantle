/**
 * The PDF drawing read on PDFs this test writes itself (the repo is public:
 * no real drawing is in it). pdfjs runs for real; the eye is a stub, as its
 * own tests are the Python ones (server/parser/cad/tests/test_pdf_eye.py).
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { readPdfDrawing, type EyeFn, type PdfDrawing } from './pdf-drawing';
import { pdfDrawingSheets } from './pdf-drawing-sheets';
import { assemblePdf } from './pdf-fixtures.test-helper';
import type { PageEye } from './pdf-kind';
import type { PagePrimitives } from './pdf-primitives';
import { markTemplates, pageRows, titleBlockOf, TITLE_BLOCK_MM, type PageRows } from './pdf-rows';
import { renderPdfWindows } from './rasterize';

type Page = { w: number; h: number; content: string; image?: boolean };

/** Points for a sheet size in millimetres. */
const pt = (mm: number) => Math.round((mm / 25.4) * 72);
const A4: [number, number] = [pt(297), pt(210)];
const A1: [number, number] = [pt(841), pt(594)];

function pdf(pages: Page[]): Buffer {
  const px = deflateSync(Buffer.alloc(20 * 10 * 3, 230));
  const objs: (string | [string, Buffer])[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    [
      '<< /Type /XObject /Subtype /Image /Width 20 /Height 10 /ColorSpace /DeviceRGB ' +
        `/BitsPerComponent 8 /Filter /FlateDecode /Length ${px.length} >>`,
      px,
    ],
  ];
  pages.forEach((p, i) => {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] ` +
        `/Resources << /Font << /F1 3 0 R >> /XObject << /Im0 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`,
      `<< /Length ${Buffer.byteLength(p.content, 'latin1')} >>\nstream\n${p.content}\nendstream`,
    );
  });
  return assemblePdf(objs);
}

/** `n` long horizontal lines: a drawn page. */
const ruled = (n: number, w: number) =>
  Array.from(
    { length: n },
    (_, i) => `20 ${20 + (i % 500)} m ${w - 20} ${20 + (i % 500)} l S`,
  ).join(' ');
const text = (s: string, x: number, y: number) => `BT /F1 10 Tf ${x} ${y} Td (${s}) Tj ET`;
/** A picture over the whole page. */
const fullImage = (w: number, h: number) => `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;

/** A made-up P&ID page: drawn, with line numbers and tags. */
const pidPage = (): Page => ({
  w: A1[0],
  h: A1[1],
  content: [
    ruled(1200, A1[0]),
    text('4"-P-1001-A1B', 100, 900),
    text('6"-CW-2002-C1', 100, 880),
    text('2"-HC-3003-B2A', 100, 860),
    text('FIC-101', 400, 900),
    text('made up unit, cooling water supply', 1800, 60),
  ].join(' '),
});
const letterPage = (): Page => ({
  w: A4[1],
  h: A4[0],
  content: text('Dear reader, this page is running text and nothing else at all.', 50, 700),
});
const scanPage = (): Page => ({ w: A4[0], h: A4[1], content: fullImage(...A4) });

const eyeOf = (axes: Partial<PageEye['axes']>): PageEye => ({
  axes: { h: 0.6, v: 0.3, iso: 0.03, other: 0.07, longMm: 8000, ...axes },
  skewDeg: 0,
  ink: 0.05,
  textAreas: 200,
});

describe('readPdfDrawing', () => {
  it('a drawn page with line numbers makes the file a P&ID, with no model and no eye', async () => {
    const calls: number[] = [];
    const d = await readPdfDrawing(pdf([letterPage(), pidPage()]), {
      eye: async (_png, widthMm) => {
        calls.push(widthMm);
        return null;
      },
    });
    expect(d.kind).toBe('pid');
    expect(d.pages.map((p) => [p.page, p.kind, p.class, p.size])).toEqual([
      [1, 'document', 'text', 'a4'],
      [2, 'pid', 'vector_text', 'a1'],
    ]);
    expect(d.pages[1]).toMatchObject({ lineNumbers: 3, instruments: 1, segments: 1200 });
    expect(d.sample).toBe('');
    expect(calls).toEqual([]);
  });

  it('typed pages only: a document', async () => {
    const d = await readPdfDrawing(pdf([letterPage(), letterPage()]));
    expect(d).toMatchObject({ kind: 'document', numPages: 2, sample: '' });
  });

  it('a drawn page the rules cannot name is unsure, with a text sample', async () => {
    const page: Page = {
      w: A1[0],
      h: A1[1],
      content: `${ruled(1200, A1[0])} ${text('GENERAL ARRANGEMENT OF A MADE UP VESSEL', 1800, 60)}`,
    };
    const d = await readPdfDrawing(pdf([page]));
    expect(d.kind).toBe('unsure');
    expect(d.sample).toContain('GENERAL ARRANGEMENT OF A MADE UP VESSEL');
    expect(d.sample.length).toBeLessThanOrEqual(1500);
  });

  it('looks at three raster pages spread over the file, and the others take what those say', async () => {
    const widths: number[] = [];
    const eye: EyeFn = async (png, widthMm) => {
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
      widths.push(Math.round(widthMm));
      return eyeOf({});
    };
    const d = await readPdfDrawing(
      pdf([scanPage(), scanPage(), scanPage(), scanPage(), scanPage()]),
      { eye },
    );
    expect(widths).toEqual([297, 297, 297]);
    expect(d.kind).toBe('scan');
    // The first, the middle one and the last have a picture.
    expect(d.pages.map((p) => [p.kind, p.kindFrom, p.eye !== null])).toEqual([
      ['scan', 'picture', true],
      ['scan', 'other_pages', false],
      ['scan', 'picture', true],
      ['scan', 'other_pages', false],
      ['scan', 'picture', true],
    ]);
  });

  it('typed scan pages make the pages not looked at documents, and that is stated', async () => {
    const d = await readPdfDrawing(pdf([scanPage(), scanPage(), scanPage(), scanPage()]), {
      eye: async () => eyeOf({ longMm: 150 }),
    });
    expect(d.kind).toBe('document');
    expect(d.pages.map((p) => [p.kind, p.kindFrom])).toEqual([
      ['document', 'picture'],
      ['document', 'other_pages'],
      ['document', 'picture'],
      ['document', 'picture'],
    ]);
  });

  it('a large scan among typed pages is a drawing, looked at or not: the file gets a database', async () => {
    // Pages 1, 3 and 5 are looked at (typed letters). Page 2 is a scanned A1 sheet.
    const big: Page = { w: A1[0], h: A1[1], content: fullImage(...A1) };
    const d = await readPdfDrawing(pdf([scanPage(), big, scanPage(), scanPage(), scanPage()]), {
      eye: async () => eyeOf({ longMm: 150 }),
    });
    expect(d.pages.map((p) => [p.kind, p.kindFrom])).toEqual([
      ['document', 'picture'],
      ['scan', 'rules'],
      ['document', 'picture'],
      ['document', 'other_pages'],
      ['document', 'picture'],
    ]);
    expect(d.kind).toBe('scan');
  });

  it('a raster page that was not read whole gets no picture', async () => {
    // A scan with 400 lines drawn over it, read with a path budget of 100.
    const heavy: Page = { w: A4[0], h: A4[1], content: `${fullImage(...A4)} ${ruled(400, A4[0])}` };
    const eye = vi.fn(async () => eyeOf({}));
    const d = await readPdfDrawing(pdf([heavy, scanPage()]), {
      eye,
      budgets: { maxSegments: 100, maxMs: 30_000 },
    });
    expect(eye).toHaveBeenCalledTimes(1);
    expect(d.pages.map((p) => [p.status, p.class, p.kind, p.kindFrom, p.eye !== null])).toEqual([
      ['too_large', 'scan', 'scan', 'other_pages', false],
      ['ok', 'scan', 'scan', 'picture', true],
    ]);
  });

  it('the pictures come from the render function it is given, with the deadline', async () => {
    const asked: number[][] = [];
    const d = await readPdfDrawing(pdf([scanPage(), letterPage(), scanPage()]), {
      eye: async (png) => (png.length === 1 ? eyeOf({}) : null),
      eyeDeadlineMs: 60_000,
      render: async (windows, deadline) => {
        asked.push(windows.map((w) => w.pageNumber));
        expect(deadline - Date.now()).toBeGreaterThan(50_000);
        // The first page has a picture; the other could not be drawn.
        return [
          { png: Buffer.from([1]), widthPx: 1, heightPx: 1, scale: 2, widthMm: 297, heightMm: 210 },
          null,
        ];
      },
    });
    expect(asked).toEqual([[1, 3]]);
    expect(d.pages.map((p) => [p.kind, p.kindFrom])).toEqual([
      ['scan', 'picture'],
      ['document', 'rules'],
      // Asked about, and its picture could not be drawn: not known.
      ['unsure', 'rules'],
    ]);
  });

  it('typed pages, and a page past the page cap that was not read: unsure, never a document', async () => {
    const three = pdf([letterPage(), letterPage(), letterPage()]);
    expect((await readPdfDrawing(three)).kind).toBe('document');
    const d = await readPdfDrawing(three, { maxPages: 2 });
    expect(d.numPages).toBe(3);
    expect(d.pages.map((p) => p.kind)).toEqual(['document', 'document']);
    // The third page may be the drawing: the file gets a database that
    // states the page not read, where a document would get nothing.
    expect(d.kind).toBe('unsure');
    const file = pdfDrawingSheets(d, null).sheets[0]!;
    expect(file.rows[0]![file.columns.findIndex((c) => c.name === 'Pages not read whole')]).toBe(1);
  });

  it('a typed page and a page that could not be read whole: unsure, and the answer says so', async () => {
    const ok = await readPdfDrawing(pdf([letterPage(), letterPage()]));
    expect(ok).toMatchObject({ kind: 'document', allRead: true });
  });

  it('typed pages, and pages the file budget left unread: unsure, never a document', async () => {
    const d = await readPdfDrawing(pdf([letterPage(), letterPage()]), {
      budgets: { maxSegments: 250_000, maxMs: 30_000, maxFileMs: 0 },
    });
    expect(d.pages.map((p) => [p.status, p.kind])).toEqual([
      ['too_large', 'none'],
      ['too_large', 'none'],
    ]);
    expect(d).toMatchObject({ kind: 'unsure', allRead: false });
  });

  it('a page asked about and not answered is unsure, whatever the other pictures say', async () => {
    // Three scan pages, all looked at: the first and the last are typed
    // pages, the middle one gives no answer (a white picture is refused).
    let n = 0;
    const d = await readPdfDrawing(pdf([scanPage(), scanPage(), scanPage()]), {
      eye: async () => (n++ === 1 ? null : eyeOf({ longMm: 150 })),
    });
    expect(d.pages.map((p) => [p.kind, p.kindFrom])).toEqual([
      ['document', 'picture'],
      ['unsure', 'rules'],
      ['document', 'picture'],
    ]);
    expect(d.kind).toBe('unsure');
    // The page that got no answer is in the one fact: the decider's
    // `document` cannot name this file a document either.
    expect(d.allRead).toBe(false);
    const decided = pdfDrawingSheets(d, {
      kind: 'document',
      confidence: 0.9,
      model: 'm',
      mode: 'live',
      used: true,
    });
    expect(decided.kind).toBe('unsure');
  });

  it('one drawing among the looked-at pages makes the others scans, not documents', async () => {
    let n = 0;
    const d = await readPdfDrawing(pdf([scanPage(), scanPage(), scanPage(), scanPage()]), {
      eye: async () => eyeOf(n++ === 0 ? {} : { longMm: 150 }),
    });
    expect(d.kind).toBe('scan');
    expect(d.pages.map((p) => [p.kind, p.kindFrom])).toEqual([
      ['scan', 'picture'],
      ['scan', 'other_pages'],
      ['document', 'picture'],
      ['document', 'picture'],
    ]);
  });

  it('past the picture deadline no picture is started: the facts still come back', async () => {
    const eye = vi.fn(async () => eyeOf({}));
    const d = await readPdfDrawing(pdf([scanPage(), letterPage()]), { eye, eyeDeadlineMs: 0 });
    expect(eye).not.toHaveBeenCalled();
    expect(d.pages.map((p) => [p.class, p.kind, p.kindFrom])).toEqual([
      ['scan', 'unsure', 'rules'],
      ['text', 'document', 'rules'],
    ]);
    expect(d.kind).toBe('unsure');
  });

  it('a scan with clear isometric axes is an isometric; a scan with few lines is a document', async () => {
    const iso = await readPdfDrawing(pdf([scanPage()]), {
      eye: async () => eyeOf({ iso: 0.2, other: 0.05 }),
    });
    expect(iso.kind).toBe('isometric');
    const typed = await readPdfDrawing(pdf([scanPage()]), {
      eye: async () => eyeOf({ longMm: 150 }),
    });
    expect(typed.kind).toBe('document');
  });

  it('with no eye, or an eye that cannot say, a scan stays unsure: nothing is guessed', async () => {
    expect((await readPdfDrawing(pdf([scanPage()]))).kind).toBe('unsure');
    const blind = await readPdfDrawing(pdf([scanPage()]), { eye: async () => null });
    expect(blind).toMatchObject({ kind: 'unsure', sample: '' });
    expect(blind.pages[0]!.eye).toBeNull();
    // A raster page never looked at, with nothing to go by: not all read, so
    // the decider's `document` is never used for it.
    expect(blind.allRead).toBe(false);
    const used = pdfDrawingSheets(blind, {
      kind: 'document',
      confidence: 0.99,
      mode: 'live',
      model: 'm',
      used: true,
    });
    expect(used.kind).toBe('unsure');
  });
});

describe('pdfDrawingSheets', () => {
  it('writes the kind once in File and a row a page in Pages', async () => {
    const d = await readPdfDrawing(pdf([letterPage(), pidPage()]));
    const { kind, sheets, description } = pdfDrawingSheets(d, null);
    expect(kind).toBe('pid');
    expect(sheets.map((s) => s.name)).toEqual(['File', 'Pages', 'Texts', 'Tags', 'Lines']);
    const [file, pages] = sheets as [(typeof sheets)[number], (typeof sheets)[number]];
    const cell = (sheet: typeof file, row: number, name: string) =>
      sheet.rows[row]![sheet.columns.findIndex((c) => c.name === name)];
    expect(cell(file, 0, 'Kind')).toBe('pid');
    expect(cell(file, 0, 'Kind source')).toBe('rules');
    expect(cell(file, 0, 'Decider answer')).toBeNull();
    expect(cell(file, 0, 'Pages')).toBe(2);
    expect(cell(file, 0, 'All read')).toBe(true);
    expect(pages.rows).toHaveLength(2);
    expect(cell(pages, 1, 'Kind')).toBe('pid');
    expect(cell(pages, 1, 'Kind from')).toBe('rules');
    expect(cell(pages, 1, 'Line numbers')).toBe(3);
    expect(cell(pages, 1, 'Axes from')).toBe('page');
    for (const s of sheets) for (const r of s.rows) expect(r).toHaveLength(s.columns.length);
    expect(description).toContain('piping and instrument diagram');
  });

  const unsure = () =>
    readPdfDrawing(
      pdf([
        {
          w: A1[0],
          h: A1[1],
          content: `${ruled(1200, A1[0])} ${text('SOME DRAWING TEXT OF A MADE UP SHEET', 1800, 60)}`,
        },
      ]),
    );
  const answer = { kind: 'equipment_drawing', confidence: 0.91, model: 'm', mode: 'live' as const };
  const fileCell = (out: ReturnType<typeof pdfDrawingSheets>, name: string) =>
    out.sheets[0]!.rows[0]![out.sheets[0]!.columns.findIndex((c) => c.name === name)];

  it("an unsure file takes the decider's answer only when it may be used", async () => {
    const d = await unsure();
    const used = pdfDrawingSheets(d, { ...answer, used: true });
    expect(used.kind).toBe('equipment_drawing');
    expect(fileCell(used, 'Kind source')).toBe('decider');
    expect(fileCell(used, 'Rules kind')).toBe('unsure');
    expect(fileCell(used, 'Decider confidence')).toBe(0.91);

    // Shadow, or under the floor: recorded beside the rules' kind, not used.
    const shadow = pdfDrawingSheets(d, { ...answer, mode: 'shadow', used: false });
    expect(shadow.kind).toBe('unsure');
    expect(fileCell(shadow, 'Kind source')).toBe('rules');
    expect(fileCell(shadow, 'Decider answer')).toBe('equipment_drawing');
    expect(fileCell(shadow, 'Decider mode')).toBe('shadow');
  });

  it("the decider's `document` is used only for a file the reader left nothing out of", async () => {
    const read = await readPdfDrawing(pdf([pidPage()]));
    expect(read.allRead).toBe(true);
    const d = { ...read, kind: 'unsure' as const };
    const says = {
      kind: 'document',
      confidence: 0.9,
      model: 'm',
      mode: 'live',
      used: true,
    } as const;
    expect(pdfDrawingSheets(d, says).kind).toBe('document');
    // With a page not read, the answer is kept beside the kind, not used.
    const out = pdfDrawingSheets({ ...d, allRead: false }, says);
    expect(out.kind).toBe('unsure');
    const file = out.sheets[0]!;
    const cell = (name: string) => file.rows[0]![file.columns.findIndex((c) => c.name === name)];
    expect(cell('Kind source')).toBe('rules');
    expect(cell('Decider answer')).toBe('document');
    // Any other answer is used as before.
    expect(pdfDrawingSheets({ ...d, allRead: false }, { ...says, kind: 'pfd' }).kind).toBe('pfd');
  });

  it('an answer that is no kind is never used, and never changes a kind the rules gave', async () => {
    const odd = pdfDrawingSheets(await unsure(), { ...answer, kind: 'DROP TABLE', used: true });
    expect(odd.kind).toBe('unsure');
    const pid = await readPdfDrawing(pdf([pidPage()]));
    expect(pdfDrawingSheets(pid, { ...answer, used: true }).kind).toBe('pid');
  });
});

describe('a file that declares more pages than the reader keeps', () => {
  it('the File tab counts the pages with no row as not read, and the description says so', async () => {
    const d = await readPdfDrawing(pdf([pidPage()]));
    const out = pdfDrawingSheets({ ...d, numPages: 9000 }, null);
    const file = out.sheets[0]!;
    const cell = (name: string) => file.rows[0]![file.columns.findIndex((c) => c.name === name)];
    expect(cell('Pages')).toBe(9000);
    expect(cell('Pages not read whole')).toBe(8999);
    expect(out.description).toContain('declares 9000 pages and only the first 1 have a row');
  });
});

describe('a page that holds only markups', () => {
  it('is not known to be empty: the file is unsure, never a document', async () => {
    // An A4 page with no content of its own and one stamp on it.
    const page = (annots: string) =>
      assemblePdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4[0]} ${A4[1]}] ${annots} ` +
          '/Resources << >> /Contents 4 0 R >>',
        '<< /Length 0 >>\nstream\n\nendstream',
      ]);
    const stamped = await readPdfDrawing(
      page('/Annots [<< /Type /Annot /Subtype /Stamp /Rect [50 50 500 400] >>]'),
    );
    expect(stamped.pages.map((p) => [p.class, p.kind, p.notes])).toEqual([
      ['blank', 'unsure', ['drawn_content_not_read']],
    ]);
    expect(stamped.kind).toBe('unsure');
    // The known skip is in the one fact, so the decider's `document` cannot
    // name the file a document either (audit round 7, second report, M-1).
    expect(stamped.allRead).toBe(false);
    const decided = pdfDrawingSheets(stamped, {
      kind: 'document',
      confidence: 0.9,
      model: 'm',
      mode: 'live',
      used: true,
    });
    expect(decided.kind).toBe('unsure');
    // The same page with nothing on it is an empty page of a document.
    const empty = await readPdfDrawing(page(''));
    expect(empty.pages.map((p) => [p.class, p.kind])).toEqual([['blank', 'document']]);
    expect(empty).toMatchObject({ kind: 'document', allRead: true });
  });
});

describe('a page whose picture is too large to read', () => {
  /** One A4 page that draws one image, declared `w` by `h` pixels. */
  const imagePage = (w: number, h: number): Buffer => {
    const px = deflateSync(Buffer.alloc(30, 230));
    const content = fullImage(...A4);
    return assemblePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4[0]} ${A4[1]}] ` +
        '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      [
        `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray ` +
          `/BitsPerComponent 1 /Filter /FlateDecode /Length ${px.length} >>`,
        px,
      ],
    ]);
  };

  it('the file is never a document: the page was not read, and the File tab says so', async () => {
    // 12,000 by 10,000 pixels: over what the reader opens. The page then
    // reads as empty, on an office sheet.
    const d = await readPdfDrawing(imagePage(12_000, 10_000));
    expect(d).toMatchObject({ largeImageNotRead: true, allRead: false });
    expect(d.pages.map((p) => p.kind)).not.toContain('none');
    expect(d.kind).toBe('unsure');
    // The same page with a small image is read, and nothing is flagged.
    const small = await readPdfDrawing(imagePage(3, 10));
    expect(small.largeImageNotRead).toBe(false);
  });
});

describe('what a read states beside the kinds', () => {
  it('a file with an image too large to read says so in the File tab', async () => {
    const d = await readPdfDrawing(pdf([pidPage()]));
    expect(d.largeImageNotRead).toBe(false);
    const cellOf = (drawing: typeof d, name: string) => {
      const file = pdfDrawingSheets(drawing, null).sheets[0]!;
      return file.rows[0]![file.columns.findIndex((c) => c.name === name)];
    };
    expect(cellOf(d, 'Large image not read')).toBe(false);
    const big = { ...d, largeImageNotRead: true };
    expect(cellOf(big, 'Large image not read')).toBe(true);
    expect(pdfDrawingSheets(big, null).description).toContain('an image too large to read');
  });

  it("a page's notes go to its Notes cell", async () => {
    const d = await readPdfDrawing(pdf([pidPage()]));
    const noted = { ...d, pages: [{ ...d.pages[0]!, notes: ['bubbles_not_paired' as const] }] };
    const pages = pdfDrawingSheets(noted, null).sheets[1]!;
    const at = pages.columns.findIndex((c) => c.name === 'Notes');
    expect(pages.rows[0]![at]).toBe('bubbles_not_paired');
    expect(pdfDrawingSheets(d, null).sheets[1]!.rows[0]![at]).toBeNull();
  });
});

describe('renderPdfWindows', () => {
  it('a window whose render throws is null, and the others still come back', async () => {
    const seen: number[] = [];
    const out = await renderPdfWindows(
      pdf([scanPage(), scanPage(), scanPage()]),
      [
        { pageNumber: 1, scale: 1 },
        { pageNumber: 2, scale: 1 },
        { pageNumber: 3, scale: 1 },
      ],
      {
        // `each` runs inside the window's own try: a throw there is the
        // same path as a throw of the render itself.
        each: async (_picture, i) => {
          seen.push(i);
          if (i === 1) throw new Error('this window fails');
        },
      },
    );
    expect(seen).toEqual([0, 1, 2]);
    expect(out).toEqual([null, null, null]);
  });

  it('a page whose canvas cannot be made is null, and the next page is drawn', async () => {
    const real = await import('@napi-rs/canvas');
    let made = 0;
    vi.doMock('@napi-rs/canvas', () => ({
      ...real,
      createCanvas: (w: number, h: number) => {
        if (++made === 1) throw new Error('no canvas for this one');
        return real.createCanvas(w, h);
      },
    }));
    try {
      const [first, second] = await renderPdfWindows(pdf([scanPage(), scanPage()]), [
        { pageNumber: 1, scale: 1 },
        { pageNumber: 2, scale: 1 },
      ]);
      expect(made).toBe(2);
      expect(first).toBeNull();
      expect(second).toMatchObject({ widthPx: A4[0], heightPx: A4[1] });
    } finally {
      vi.doUnmock('@napi-rs/canvas');
    }
  });

  it('renders a page and a window of it, each as its own picture', async () => {
    const [whole, part, gone, empty] = await renderPdfWindows(pdf([scanPage()]), [
      { pageNumber: 1, scale: 1 },
      { pageNumber: 1, scale: 4, box: [0.5, 0.5, 1, 1] },
      { pageNumber: 2, scale: 1 },
      { pageNumber: 1, scale: 1, box: [0.4, 0.4, 0.4, 0.9] },
    ]);
    expect(whole).toMatchObject({ widthPx: A4[0], heightPx: A4[1], scale: 1 });
    expect(Math.round(whole!.widthMm)).toBe(297);
    // A quarter of the page at four times the scale: twice the pixels a side.
    expect(part).toMatchObject({ widthPx: A4[0] * 2, heightPx: Math.floor(A4[1] * 2), scale: 4 });
    expect(Math.round(part!.widthMm)).toBe(149);
    expect(part!.png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(gone).toBeNull();
    expect(empty).toBeNull();
  });

  it('a window not started by the deadline is null, and the others are untouched', async () => {
    const out = await renderPdfWindows(
      pdf([scanPage()]),
      [
        { pageNumber: 1, scale: 1 },
        { pageNumber: 1, scale: 1 },
      ],
      { deadline: Date.now() - 1 },
    );
    expect(out).toEqual([null, null]);
  });

  it('with `each`, a picture is handed over at once and not kept', async () => {
    const seen: number[] = [];
    const out = await renderPdfWindows(
      pdf([scanPage(), scanPage()]),
      [
        { pageNumber: 1, scale: 1 },
        { pageNumber: 2, scale: 1 },
      ],
      {
        each: async (picture, i) => {
          seen.push(i, picture.widthPx);
        },
      },
    );
    expect(seen).toEqual([0, A4[0], 1, A4[0]]);
    expect(out).toEqual([null, null]);
  });

  it('lowers the scale of a window that would pass the pixel cap', async () => {
    const [big] = await renderPdfWindows(
      pdf([{ w: 4000, h: 4000, content: fullImage(4000, 4000) }]),
      [{ pageNumber: 1, scale: 4 }],
    );
    expect(big!.scale).toBeLessThan(4);
    expect(big!.widthPx * big!.heightPx).toBeLessThanOrEqual(4096 * 4096);
  });
});

describe('the rows of a page (the words, tags, line numbers and markups)', () => {
  /** A drawn A1 page with made-up text: each entry is its own text line. */
  const sheet = (...entries: [string, number, number][]): Page => ({
    w: A1[0],
    h: A1[1],
    content: [ruled(1200, A1[0]), ...entries.map(([s, x, y]) => text(s, x, y))].join(' '),
  });
  const busy = sheet(
    ['4"-P-1001-A1B', 100, 900],
    ['6"-CW-2002-C1', 100, 880],
    ['2"-HC-3003-B2A', 100, 860],
    ['FIC-101', 400, 900], // an instrument tag in one token
    ['PT', 600, 900], // a bubble: the code ...
    ['202', 600, 888], // ... and its loop number under it
    ['U2-E-12A', 800, 900], // equipment with a unit
    ['TK-7', 800, 880], // equipment with no unit
    ['U2-P-1A/B', 800, 860], // a list: two tags
    ['U2-C-1A-E1', 800, 840], // a fourth part
    ['12-AB-CD', 800, 820], // the tag shape, and no pattern fits
    ['NOTE-3', 800, 800], // the tag shape, a word of the frame
    ['plain words here', 800, 780],
    ['U2-V-9', A1[0] - 100, 40], // in the title block corner
  );

  it('every tag-like token ends in one place, and the counts add up', async () => {
    const d = await readPdfDrawing(pdf([busy]));
    const { rows } = d.pages[0]!;
    const a = rows!.account;
    expect(a.tagLike).toBe(a.asInstrument + a.asEquipment + a.asLine + a.rejected);
    expect(a).toMatchObject({
      asInstrument: 1,
      asEquipment: 4, // U2-E-12A, TK-7, U2-C-1A-E1, U2-V-9
      asLine: 0, // an inch mark is not in the wide shape
      rejected: 2, // 12-AB-CD and NOTE-3
      otherTagTokens: 4, // three line numbers and the list
      fromLists: 1,
      bubbles: 1,
    });
    // The page's own count of the wide shape is the same number.
    expect(a.tagLike).toBe(d.pages[0]!.tagLike);
    expect(a.words).toBe(rows!.words.length);
    // Every row is there: the tags and line numbers of the text add up too.
    const fromText = rows!.tags.filter((t) => t.source === 'text').length + rows!.lines.length;
    expect(fromText).toBe(
      a.asInstrument + a.asEquipment + a.asLine + a.otherTagTokens + a.fromLists,
    );
    expect(rows!.tags.filter((t) => t.source === 'bubble')).toHaveLength(a.bubbles);
  });

  it('lists each tag with its parts, its key and how sure it is', async () => {
    const { rows } = (await readPdfDrawing(pdf([busy]))).pages[0]!;
    const tag = (t: string) => rows!.tags.find((r) => r.tag === t);
    expect(tag('FIC-101')).toMatchObject({
      type: 'instrument',
      letters: 'FIC',
      number: '101',
      source: 'text',
      confidence: 0.95,
    });
    expect(tag('PT-202')).toMatchObject({ type: 'instrument', source: 'bubble', raw: 'PT 202' });
    expect(tag('U2-E-12A')).toMatchObject({
      type: 'equipment',
      unit: 'U2',
      letters: 'E',
      number: '12A',
      key: 'U2E12A',
      confidence: 0.9,
    });
    expect(tag('TK-7')).toMatchObject({ unit: '', confidence: 0.6 });
    expect(tag('U2-P-1A')).toMatchObject({ raw: 'U2-P-1A/B' });
    expect(tag('U2-P-1B')).toMatchObject({ raw: 'U2-P-1A/B' });
    expect(tag('U2-C-1A-E1')).toMatchObject({ number: '1A-E1', key: 'U2C1AE1' });
    expect(tag('NOTE-3')).toBeUndefined();
    expect(rows!.lines.map((l) => [l.line, l.size, l.serial, l.confidence])).toEqual([
      ['4"-P-1001-A1B', '4"', '1001', 0.95],
      ['6"-CW-2002-C1', '6"', '2002', 0.95],
      ['2"-HC-3003-B2A', '2"', '3003', 0.95],
    ]);
    // A tag's box is its word's box, inside the page.
    const box = tag('U2-E-12A')!.box;
    expect(box[0]).toBeGreaterThan(0);
    expect(box[2]).toBeLessThan(1);
    expect(box[2]).toBeGreaterThan(box[0]);
  });

  it('flags the title block corner by position, and still lists the tag in it', async () => {
    const d = await readPdfDrawing(pdf([busy]));
    const rows = d.pages[0]!.rows!;
    const tag = rows.tags.find((t) => t.tag === 'U2-V-9')!;
    expect(rows.words[tag.word]).toMatchObject({ text: 'U2-V-9', region: 'title_block' });
    expect(rows.words.find((w) => w.text === 'FIC-101')!.region).toBe('body');
    // The tabs carry the word's flag on the tag.
    const tags = pdfDrawingSheets(d, null).sheets.find((s) => s.name === 'Tags')!;
    const col = (name: string) => tags.columns.findIndex((c) => c.name === name);
    const row = tags.rows.find((r) => r[col('Tag')] === 'U2-V-9')!;
    expect(row[col('Region')]).toBe('title_block');
    expect(row[col('Hidden')]).toBe(false);
    expect(row[col('Key')]).toBe('U2V9');
  });

  it('the same word at the same place on three pages is template text; on two it is not', () => {
    const page = (texts: [string, number][]): PageRows => ({
      words: texts.map(([t, x], i) => ({
        line: i + 1,
        text: t,
        box: [x, 0.5, x + 0.02, 0.51],
        angle: 0,
        sizeMm: 2,
        hidden: false,
        spaced: false,
        region: 'body',
      })),
      tags: [],
      lines: [],
      markups: [],
      account: {
        words: texts.length,
        tagLike: 0,
        asInstrument: 0,
        asEquipment: 0,
        asLine: 0,
        rejected: 0,
        otherTagTokens: 0,
        fromLists: 0,
        bubbles: 0,
      },
    });
    const pages = [
      page([
        ['CLIENT', 0.1],
        ['E-1', 0.4],
      ]),
      page([
        ['CLIENT', 0.1],
        ['E-1', 0.6],
      ]), // the tag, at another place
      page([
        ['CLIENT', 0.1],
        ['E-2', 0.4],
      ]),
      null,
    ];
    markTemplates(pages);
    expect(pages.map((p) => p?.words.map((w) => w.region))).toEqual([
      ['template', 'body'],
      ['template', 'body'],
      ['template', 'body'],
      undefined,
    ]);
    const two = [page([['CLIENT', 0.1]]), page([['CLIENT', 0.1]])];
    markTemplates(two);
    expect(two.map((p) => p.words[0]!.region)).toEqual(['body', 'body']);
  });

  it('a typed page of a document gives no rows; the drawing page of the same file does', async () => {
    const d = await readPdfDrawing(pdf([letterPage(), busy]));
    expect(d.pages.map((p) => [p.kind, p.rows !== undefined])).toEqual([
      ['document', false],
      ['pid', true],
    ]);
    const out = pdfDrawingSheets(d, null);
    expect(out.sheets.map((s) => s.name)).toEqual(['File', 'Pages', 'Texts', 'Tags', 'Lines']);
    const texts = out.sheets[2]!;
    // Every word row is of page 2.
    expect(new Set(texts.rows.map((r) => r[0]))).toEqual(new Set([2]));
    expect(out.description).toContain('Texts: a word a row');
  });

  it('a markup with text is a row, with the drawn markup beside it and the tags in its text', async () => {
    const content = `${ruled(1200, A1[0])} ${text('4"-P-1001-A1B', 100, 900)}`;
    const marked = assemblePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A1[0]} ${A1[1]}] ` +
        '/Annots [' +
        '<< /Type /Annot /Subtype /FreeText /Rect [300 300 420 330] /Contents (replace PSV-0012) /T (A Person) /DA (/Helv 9 Tf 0 g) >> ' +
        '<< /Type /Annot /Subtype /Line /Rect [420 300 520 400] /L [420 315 520 400] >> ' +
        '<< /Type /Annot /Subtype /Circle /Rect [1500 1500 1600 1600] >> ' +
        // A cloud with a comment: a drawn markup holds text too.
        '<< /Type /Annot /Subtype /Polygon /IT /PolygonCloud /Rect [800 800 900 900] /Vertices [800 800 900 800 900 900 800 900] /Contents (REPLACE U2-P-1A WITH U2-P-1B) >>' +
        '] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]);
    const d = await readPdfDrawing(marked);
    const rows = d.pages[0]!.rows!;
    expect(rows.markups.map((m) => [m.kind, m.text, m.author, m.besideKind])).toEqual([
      ['FreeText', 'replace PSV-0012', 'A Person', 'Line'],
      ['Line', '', '', ''],
      ['Circle', '', '', ''],
      ['Polygon', 'REPLACE U2-P-1A WITH U2-P-1B', '', ''],
    ]);
    expect(rows.tags.find((t) => t.source === 'markup')).toMatchObject({
      tag: 'PSV-0012',
      type: 'instrument',
      word: -1,
    });
    // The tags in the text of a drawn markup are listed too.
    expect(rows.tags.filter((t) => t.source === 'markup').map((t) => t.tag)).toEqual([
      'PSV-0012',
      'U2-P-1A',
      'U2-P-1B',
    ]);
    // A markup's tag is not one of the page's own tokens.
    expect(rows.account.asInstrument).toBe(0);
    const tabs = pdfDrawingSheets(d, null).sheets.map((s) => s.name);
    expect(tabs).toContain('Markups');
  });

  it('a page whose rows would pass the file cap has no rows, and says so', async () => {
    const { DRAWING_MAX_ROWS } = await import('./pdf-drawing');
    expect(DRAWING_MAX_ROWS).toBeGreaterThan(1000);
    const whole = await readPdfDrawing(pdf([busy, busy]));
    expect(whole.pages.map((p) => p.notes ?? [])).toEqual([[], []]);
    const one = whole.pages[0]!.rows!;
    // Every row counts, not the words alone: the cap holds one page's rows
    // and not one row more.
    const count = one.words.length + one.tags.length + one.lines.length + one.markups.length;
    expect(count).toBeGreaterThan(one.words.length);
    const cut = await readPdfDrawing(pdf([busy, busy]), { maxRows: count });
    expect(cut.pages[0]!.rows).toBeDefined();
    expect(cut.pages[1]!.rows).toBeUndefined();
    expect(cut.pages[1]!.notes).toContain('rows_not_listed');
    // The page keeps its kind and its counts: only its rows are left out.
    expect(cut.pages[1]!.kind).toBe(whole.pages[1]!.kind);
    expect(cut.pages[1]!.tagLike).toBe(whole.pages[1]!.tagLike);
    expect(cut.kind).toBe(whole.kind);
  });

  it('a token past the length bound gives no tag row, and the counts still add up', async () => {
    const long = `U2-P-1A${'/B'.repeat(40)}`;
    const d = await readPdfDrawing(pdf([sheet(['FIC-101', 400, 900], [long, 100, 700])]));
    const rows = d.pages[0]!.rows!;
    expect(rows.words.map((w) => w.text)).toContain(long);
    expect(rows.tags.map((t) => t.tag)).toEqual(['FIC-101']);
    const a = rows.account;
    expect(a.tagLike).toBe(a.asInstrument + a.asEquipment + a.asLine + a.rejected);
    expect(a.tagLike).toBe(d.pages[0]!.tagLike);
    expect(d.pages[0]!.instruments).toBe(1);
  });

  it('an instrument tag with a list gives a row an item, in one token and in a bubble', async () => {
    const d = await readPdfDrawing(
      pdf([
        sheet(
          ['PSV-101A/B', 400, 900], // one token with a list
          ['PSV', 600, 900], // a bubble: the code ...
          ['202A/B', 600, 888], // ... and its number with a list
          ['1-1/2"-P-1001-A1A', 100, 900], // a line number with a fraction size
        ),
      ]),
    );
    const page = d.pages[0]!;
    const rows = page.rows!;
    expect(rows.tags.map((t) => [t.tag, t.source]).sort()).toEqual([
      ['PSV-101A', 'text'],
      ['PSV-101B', 'text'],
      ['PSV-202A', 'bubble'],
      ['PSV-202B', 'bubble'],
    ]);
    expect(rows.lines.map((l) => [l.line, l.size])).toEqual([['1-1/2"-P-1001-A1A', '1-1/2"']]);
    const a = rows.account;
    expect(a).toMatchObject({ asInstrument: 0, otherTagTokens: 2, fromLists: 1, bubbles: 2 });
    expect(a.tagLike).toBe(a.asInstrument + a.asEquipment + a.asLine + a.rejected);
    const fromText = rows.tags.filter((t) => t.source === 'text').length + rows.lines.length;
    expect(fromText).toBe(
      a.asInstrument + a.asEquipment + a.asLine + a.otherTagTokens + a.fromLists,
    );
    // The page's own counts read the same: four instrument tags, one line.
    expect(page.instruments).toBe(4);
    expect(page.lineNumbers).toBe(1);
  });

  it('a date under a code is no bubble; a two-digit loop with letters is', async () => {
    const d = await readPdfDrawing(
      pdf([
        sheet(
          ['PT', 400, 900], // a code ...
          ['12/05/26', 387, 888], // ... with a date under it (centred): no tag
          ['TT', 700, 900],
          ['12A/B', 692, 888], // two digits and a letter (centred): a list of loops
        ),
      ]),
    );
    const page = d.pages[0]!;
    expect(page.rows!.tags.map((t) => t.tag).sort()).toEqual(['TT-12A', 'TT-12B']);
    expect(page.rows!.account.bubbles).toBe(2);
    expect(page.instruments).toBe(2);
  });

  it('a page whose text would pass the file cap on characters has no rows, and says so', async () => {
    const { DRAWING_MAX_CHARS } = await import('./pdf-drawing');
    expect(DRAWING_MAX_CHARS).toBeGreaterThan(1_000_000);
    const whole = await readPdfDrawing(pdf([busy, busy]));
    const one = whole.pages[0]!.rows!;
    const chars = one.words.reduce((n, w) => n + w.text.length, 0);
    const cut = await readPdfDrawing(pdf([busy, busy]), { maxChars: chars });
    expect(cut.pages[0]!.rows).toBeDefined();
    expect(cut.pages[1]!.rows).toBeUndefined();
    expect(cut.pages[1]!.notes).toContain('rows_not_listed');
  });

  it('text that lies outside the shown page is not in the rows, and the page says so', async () => {
    const d = await readPdfDrawing(pdf([sheet(['FIC-101', 400, 900], ['TK-7', A1[0] + 500, 900])]));
    expect(d.pages[0]!.rows!.words.map((w) => w.text)).toEqual(['FIC-101']);
    expect(d.pages[0]!.notes).toContain('text_outside_page');
  });

  it('a page with more markups than the pairing looks at pairs none, and says so', () => {
    const mark = (kind: string, text: string, x: number) => ({
      kind,
      text,
      author: '',
      box: [x, 0.5, x + 0.01, 0.51] as [number, number, number, number],
    });
    const page = {
      page: 1,
      status: 'ok',
      widthMm: 841,
      heightMm: 594,
      texts: [],
      annotations: [mark('FreeText', 'a note', 0.5), mark('Line', '', 0.512)],
    } as unknown as PagePrimitives;
    const paired = pageRows(page)!;
    expect(paired.markups[0]!.besideKind).toBe('Line');
    expect(paired.markupsNotPaired).toBeUndefined();
    // One text markup times one drawn markup is over a budget of 0.
    const not = pageRows(page, 0)!;
    expect(not.markups.map((m) => m.besideKind)).toEqual(['', '']);
    expect(not.markupsNotPaired).toBe(true);
  });
});

describe('the title block box (an option of the reader)', () => {
  // A made-up A1 sheet: a word in the default corner, one left of it, and
  // a tag in the body. Three times, so the template marking runs too.
  const sheet = (): Page => ({
    w: A1[0],
    h: A1[1],
    content: [
      ruled(1200, A1[0]),
      text('4"-P-1001-A1B', 100, 900),
      text('FIC-101', 400, 900),
      text('REV-A', 1500, 100),
      text('DRG-0001', 2000, 100),
    ].join(' '),
  });
  const files = () => [pdf([letterPage(), pidPage()]), pdf([sheet(), sheet(), sheet()])];
  const rowsOf = (d: PdfDrawing) => d.pages.map((p) => p.rows ?? null);
  const hashOf = (v: unknown) =>
    createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
  const regionOf = (d: PdfDrawing, word: string) =>
    d.pages[0]!.rows!.words.find((w) => w.text === word)!.region;

  it('with the defaults the rows are those of before the option, row for row', async () => {
    const reads = await Promise.all(files().map((b) => readPdfDrawing(b)));
    // The hash of these rows as the reader gave them before the option
    // (f647e38d2). A change here is a change of the rows of every box.
    expect(hashOf(reads.map(rowsOf))).toBe('4fda418b8b3b4aff');
    const passed = await Promise.all(
      files().map((b) => readPdfDrawing(b, { titleBlock: { ...TITLE_BLOCK_MM } })),
    );
    expect(passed.map(rowsOf)).toEqual(reads.map(rowsOf));
  });

  it('with a wider box a word that was body is title_block, in the rows and in the tabs', async () => {
    const bytes = pdf([sheet()]);
    const before = await readPdfDrawing(bytes);
    const wider = await readPdfDrawing(bytes, { titleBlock: { width: 350, height: 70 } });
    expect(regionOf(before, 'REV-A')).toBe('body');
    expect(regionOf(wider, 'REV-A')).toBe('title_block');
    // The corner word stays, the body stays body.
    expect(regionOf(before, 'DRG-0001')).toBe('title_block');
    expect(regionOf(wider, 'DRG-0001')).toBe('title_block');
    expect(regionOf(wider, 'FIC-101')).toBe('body');
    const texts = pdfDrawingSheets(wider, null).sheets.find((s) => s.name === 'Texts')!;
    const at = (name: string) => texts.columns.findIndex((c) => c.name === name);
    expect(texts.rows.filter((r) => r[at('Text')] === 'REV-A').map((r) => r[at('Region')])).toEqual(
      ['title_block'],
    );
  });

  it('titleBlockOf reads the box from options, and gives the default for a side left out or not a size', () => {
    expect(titleBlockOf({})).toEqual(TITLE_BLOCK_MM);
    expect(titleBlockOf({ title_block_width_mm: 250 })).toEqual({ width: 250, height: 70 });
    expect(
      titleBlockOf({ title_block_width_mm: 0, title_block_height_mm: '90' as unknown as number }),
    ).toEqual(TITLE_BLOCK_MM);
  });
});
