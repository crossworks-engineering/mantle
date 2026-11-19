/**
 * The book (the large-PDF plan, page 4ff4d4e5): the router's rule `bookOf`
 * and its step's book path, and the step of the Agent `pdf-page-read` on
 * made-up PDFs drawn by the real pdfjs in this process. No parser, no
 * model. No client file: every PDF is built here.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assemblePdf } from '../../../pdf-fixtures.test-helper';
import {
  BOOK_MIN_PAGES,
  BOOK_SAMPLE_PAGES,
  bookOf,
  bookUnsureOf,
  officePaperOf,
} from '../../../pdf-kind';
import { PDF_MAX_BYTES } from '../../../pdf-open';
import { renderPdfWindows } from '../../../rasterize';
import { BUILTIN_PIPELINES } from '../../builtin';
import {
  PIPELINE_API,
  PIPELINE_ASK_PAGE_MAX,
  PIPELINE_PAGE_NUMBER_MAX,
  VISION_WORKER,
  type PictureAskInput,
  type PipelineStepRequest,
} from '../../contract';
import { checkStepResult } from '../../step-check';
import { inProcessStepJob } from '../../test-job';
import { step as routerStep } from '../pdf-router/step';
import { FIELDS, KIND, PAGES_DEFAULT, pagesOf, step, visionPagesOf } from './step';

/** Points of a sheet. */
const A4 = { w: 595.28, h: 841.89 };
const A1 = { w: 2383.94, h: 1683.78 };

/** A made-up PDF of `n` typed pages of `size`: a few lines of words on
 *  each. A page in `empty` has no content. */
function typedPdf(n: number, size = A4, empty: readonly number[] = []): Buffer {
  const pageObj = (p: number) => 4 + p * 2;
  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, p) => `${pageObj(p)} 0 R`).join(' ')}] /Count ${n} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let p = 0; p < n; p++) {
    const lines = Array.from(
      { length: 6 },
      (_, l) =>
        `BT /F1 11 Tf 60 ${size.h - 80 - l * 16} Td (MADE-UP SPEC BOOK PAGE ${p + 1} LINE ${l + 1} THE PIPING SHALL BE TESTED) Tj ET`,
    ).join(' ');
    const content = empty.includes(p + 1) ? ' ' : lines;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.w} ${size.h}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj(p) + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  return assemblePdf(objs);
}

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function jobOf(bytes: Buffer, helpers: Parameters<typeof inProcessStepJob>[2] = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdf-page-read-'));
  dirs.push(dir);
  const drawn: number[][] = [];
  const job = inProcessStepJob(bytes, dir, {
    pdfPictures: async (windows) => {
      drawn.push(windows.map((w) => w.pageNumber));
      return renderPdfWindows(bytes, windows).catch(() => windows.map(() => null));
    },
    ...helpers,
  });
  return { job, dir, drawn };
}

const request = (over: Partial<PipelineStepRequest> = {}): PipelineStepRequest => ({
  api: PIPELINE_API,
  step: 1,
  file: { name: 'book.pdf', ext: 'pdf', size: 1, sha256: '0'.repeat(64) },
  options: {},
  asks: true,
  ...over,
});

const inputs = (calls: readonly unknown[] | undefined) =>
  (calls ?? []).map((c) => {
    const call = c as { key: string; worker: string; input: PictureAskInput };
    return {
      key: call.key,
      worker: call.worker,
      picture: call.input.picture,
      page: call.input.page,
    };
  });

describe('bookOf: a long run of office pages, mostly scans or typed text', () => {
  const typed = { class: 'text' as const, size: 'a4' as const, kind: 'document' as const };
  const scan = { class: 'scan' as const, size: 'a4' as const, kind: 'scan' as const };
  type SamplePage = Parameters<typeof bookOf>[1][number];
  const sample = (n: number, page: SamplePage = typed) => Array.from({ length: n }, () => page);

  it('more than BOOK_MIN_PAGES pages of A4 text or scans is a book; so is a short file of typed or scanned text', () => {
    expect(BOOK_MIN_PAGES).toBe(20);
    expect(bookOf(21, sample(20))).toBe(true);
    expect(bookOf(1679, sample(20, { ...scan, kind: 'document' }))).toBe(true);
    expect(bookOf(null, sample(20))).toBe(false);
    // Every office PDF, whatever its size (rules 4): one typed page, seven.
    expect(bookOf(20, sample(20))).toBe(true);
    expect(bookOf(1, sample(1))).toBe(true);
    expect(bookOf(7, sample(7))).toBe(true);
  });

  it('a short file needs text pages but for a few: a short scanned drawing or ruled form stays a drawing', () => {
    // A scanned sketch or ruled form on A4 paper (kind `scan`): the drawing reader's.
    expect(bookOf(1, sample(1, scan))).toBe(false);
    expect(bookOf(3, sample(3, scan))).toBe(false);
    // Seven scanned pages, one of them a ruled table (kind `scan`): a book.
    const scannedText = { ...scan, kind: 'document' as const };
    expect(bookOf(7, [...sample(6, scannedText), scan])).toBe(true);
    // Two of four: not text but for a few (DOCUMENT_MIN_SHARE 0.75).
    expect(bookOf(4, [...sample(2, scannedText), ...sample(2, scan)])).toBe(false);
    // Over BOOK_MIN_PAGES, ruled scans past a fifth of the sample that the
    // eye did not read as tables: a scanned drawing set (M3), not a book.
    expect(bookOf(40, sample(20, scan))).toBe(false);
    expect(bookOf(40, [...sample(16, scannedText), ...sample(4, scan)])).toBe(true);
    expect(bookOf(40, [...sample(15, scannedText), ...sample(5, scan)])).toBe(false);
  });

  it('a long scan of A4 or A3 ruled sheets is a book only when the eye reads them as tables (M3)', () => {
    const scannedText = { ...scan, kind: 'document' as const };
    const axes = (iso: number) => ({ h: 0.95 - iso, v: 0.05, iso, other: 0, longMm: 15_911 });
    const eyed = (iso: number, textAreas: number, size: 'a4' | 'a3' = 'a4') => ({
      ...scan,
      size,
      eye: { axes: axes(iso), skewDeg: 0, ink: 0.08, textAreas },
    });
    // A spec book of scanned tables: one ruled page looked at, a table.
    expect(bookOf(300, [...sample(10, scannedText), eyed(0, 267), ...sample(9, scan)])).toBe(true);
    // A 30-sheet scanned A3 P&ID set: ruled sheets, not tables.
    expect(bookOf(30, sample(20, { ...scan, size: 'a3' }))).toBe(false);
    expect(bookOf(30, [eyed(0, 267, 'a3'), ...sample(19, { ...scan, size: 'a3' })])).toBe(false);
    // A scanned isometric package under ISO_MIN_SHARE: slanted lines, few text areas.
    expect(bookOf(60, [eyed(0.002, 60), ...sample(19, scan)])).toBe(false);
  });

  it('a short scan whose ruled pages the eye reads as tables is a book; slanted lines keep a drawing', () => {
    const scannedText = { ...scan, kind: 'document' as const };
    const axes = (iso: number) => ({ h: 0.95 - iso, v: 0.05, iso, other: 0, longMm: 15_911 });
    const eyed = (iso: number, textAreas: number, size: 'a4' | 'a3' = 'a4') => ({
      ...scan,
      size,
      eye: { axes: axes(iso), skewDeg: 0, ink: 0.08, textAreas },
    });
    // The made-up spec book scanned: pages 2 to 6 ruled tables, one looked at.
    const book = [scannedText, scan, scan, eyed(0, 267), scan, scan, scannedText];
    expect(bookOf(7, book)).toBe(true);
    // An isometric sketch form: slanted lines (0.02 and more).
    expect(bookOf(1, [eyed(0.02, 267)])).toBe(false);
    // Few text areas: a ruled drawing form, not a table.
    expect(bookOf(1, [eyed(0, 60)])).toBe(false);
    // On A3: never judged a table by its lines.
    expect(bookOf(1, [eyed(0, 267, 'a3')])).toBe(false);
    // No eye at all: not known to be a table.
    expect(bookOf(2, [scan, scan])).toBe(false);
  });

  it('large sheets past a fifth of the sample, a P&ID or an isometric make a drawing set', () => {
    const large: SamplePage = { class: 'scan', size: 'a1' };
    // One fold-out sheet in a spec book: still a book.
    expect(bookOf(40, [...sample(19), large])).toBe(true);
    expect(bookOf(40, [...sample(15), ...sample(5, large)])).toBe(false);
    expect(bookOf(40, [...sample(19), { class: 'vector_text', size: 'a3', kind: 'pid' }])).toBe(
      false,
    );
    expect(bookOf(40, [...sample(19), { ...scan, kind: 'isometric' }])).toBe(false);
  });

  it('mostly: at least 80% scans or typed text; a sample with no page read is no book', () => {
    const drawn = {
      class: 'vector_no_text' as const,
      size: 'a4' as const,
      kind: 'other_drawing' as const,
    };
    expect(bookOf(40, [...sample(16), ...sample(4, drawn)])).toBe(true);
    expect(bookOf(40, [...sample(15), ...sample(5, drawn)])).toBe(false);
    expect(bookOf(40, [{}, {}])).toBe(false);
  });
});

describe('the router names a book', () => {
  it('a 25-page typed A4 file is a book, with no ask and no facts', async () => {
    const pdf = typedPdf(BOOK_MIN_PAGES + 5);
    const { job } = jobOf(pdf);
    const r = await routerStep(request(), job);
    expect(r).toEqual({ status: 'ok', kind: 'book' });
    expect(checkStepResult(r)).toMatchObject({ ok: true });
  });

  it('a file past the size pdfjs opens is a book, with no page read', async () => {
    const { job } = jobOf(Buffer.from('not read'), {
      pdfPageCount: async () => {
        throw new Error('no page count is read');
      },
    });
    const big = request({
      file: { name: 'b.pdf', ext: 'pdf', size: PDF_MAX_BYTES + 1, sha256: '0'.repeat(64) },
    });
    expect(await routerStep(big, job)).toEqual({ status: 'ok', kind: 'book' });
  });

  it('a short typed file is a book too (rules 4); a long set of large sheets takes the page rules', async () => {
    for (const n of [1, 7, BOOK_MIN_PAGES]) {
      const short = await routerStep(request(), jobOf(typedPdf(n)).job);
      expect(short, `${n} pages`).toEqual({ status: 'ok', kind: 'book' });
    }
    const large = await routerStep(request(), jobOf(typedPdf(BOOK_MIN_PAGES + 2, A1)).job);
    expect(large.kind).not.toBe('book');
    expect(BOOK_SAMPLE_PAGES).toBe(20);
  });
});

describe('the router: an ambiguous short scan, and a table, by the decider', () => {
  const scannedText = { class: 'scan' as const, size: 'a4' as const, kind: 'document' as const };
  const ruled = { class: 'scan' as const, size: 'a4' as const, kind: 'scan' as const };
  const answer = (kind: string, used = true) => ({
    ok: true as const,
    output: { kind, confidence: 0.9, model: 'made-up', mode: 'live', used },
  });

  it("a short scan of text and ruled pages is the decider's; text only, or ruled only, is not", () => {
    expect(bookUnsureOf(4, [scannedText, scannedText, ruled, ruled])).toBe(true);
    // Text but for a few: a book by the rules, no ask.
    expect(bookUnsureOf(7, [...Array(6).fill(scannedText), ruled])).toBe(false);
    // Ruled only (a scanned sketch or form): the drawing reader's, no ask.
    expect(bookUnsureOf(3, [ruled, ruled, ruled])).toBe(false);
    // A long file of typed letters and forms past a fifth of its pages: no
    // book by the long rule, so the decider is asked too (a QA dossier).
    expect(bookUnsureOf(300, [...Array(6).fill(scannedText), ...Array(4).fill(ruled)])).toBe(true);
    // A long file the long rule names a book: no ask.
    expect(bookUnsureOf(300, [...Array(9).fill(scannedText), ruled])).toBe(false);
    // A long scanned set of large sheets with a cover page: no office pages, no ask.
    expect(
      bookUnsureOf(300, [
        { ...scannedText, size: 'a1' },
        ...Array(9).fill({ ...ruled, size: 'a1' }),
      ]),
    ).toBe(false);
  });

  it('the decider: table or document makes a mixed scan a book, a drawing kind keeps it a drawing', async () => {
    const two = (kind: string, used = true) =>
      routerStep(
        request({ step: 2, answers: [answer(kind, used)], state: { mixedScanKind: 'scan' } }),
        jobOf(typedPdf(1)).job,
      );
    expect((await two('table')).kind).toBe('book');
    expect((await two('document')).kind).toBe('book');
    expect((await two('isometric')).kind).toBe('scan');
    // A shadow answer is not used: the rules' kind stands.
    expect((await two('table', false)).kind).toBe('scan');
  });

  it('an unsure file the decider calls a table of rows is a book; a drawing kind stays', async () => {
    const two = (kind: string, state?: Record<string, unknown>) =>
      routerStep(
        request({ step: 2, answers: [answer(kind)], ...(state ? { state } : {}) }),
        jobOf(typedPdf(1)).job,
      );
    expect((await two('table')).kind).toBe('book');
    expect((await two('pfd')).kind).toBe('pfd');
    // A document on drawing sheets: it keeps its database, the drawing reader's.
    expect((await two('document')).kind).toBe('unsure');
    // A document on office paper (a typed manual whose first pages hold
    // charts): every office PDF is a book (M2).
    expect((await two('document', { officePaper: true })).kind).toBe('book');
    expect((await two('pfd', { officePaper: true })).kind).toBe('pfd');
  });

  it('office paper: BOOK_MIN_SHARE of the pages read on A4, Letter or A3', () => {
    expect(officePaperOf([{ class: 'vector_text', size: 'a4' }])).toBe(true);
    expect(officePaperOf([{ class: 'vector_text', size: 'a1' }])).toBe(false);
    expect(officePaperOf([])).toBe(false);
  });
});

describe('the step of pdf-page-read', () => {
  it('asks once a page for the marked pages of its window, keyed page-N of the original file', async () => {
    const pdf = typedPdf(5);
    const { job, dir, drawn } = jobOf(pdf);
    // The window holds pages 11 to 15 of the file; 12 and 14 are marked,
    // 3 and 30 are in other windows.
    const r = await step(
      request({
        kind: KIND,
        pageFrom: 11,
        pageTo: 15,
        pagesTotal: 40,
        state: { visionPages: [30, 14, 3, 12, 12] },
      }),
      job,
    );
    expect(r.status).toBe('ok');
    expect(drawn).toEqual([[2, 4]]);
    expect(inputs(r.calls)).toEqual([
      { key: 'page-12', worker: VISION_WORKER, picture: 'page-12.png', page: 12 },
      { key: 'page-14', worker: VISION_WORKER, picture: 'page-14.png', page: 14 },
    ]);
    for (const c of r.calls ?? []) {
      expect((c as { input: PictureAskInput }).input.fields).toEqual(FIELDS);
    }
    expect(readFileSync(path.join(dir, 'page-12.png')).subarray(1, 4).toString()).toBe('PNG');
    expect(checkStepResult(r)).toMatchObject({ ok: true });
    expect(BUILTIN_PIPELINES.find((p) => p.id === 'pdf-page-read')?.produces).toMatchObject({
      pages: true,
    });
  });

  it('a whole file (no window): its own page count; the option caps the marked pages from the first', async () => {
    const { job, drawn } = jobOf(typedPdf(4));
    const r = await step(
      request({ kind: KIND, options: { pages: 2 }, state: { visionPages: [4, 2, 3] } }),
      job,
    );
    expect(inputs(r.calls).map((c) => c.key)).toEqual(['page-2', 'page-3']);
    expect(drawn).toEqual([[2, 3]]);
    // The marked page past the option is said, not cut in silence.
    expect(r.warnings).toEqual([
      '1 marked pages of this window are past the option pages (2), and are not read.',
    ]);
  });

  it('another kind, or no marked page in the window, asks nothing', async () => {
    const { job, drawn } = jobOf(typedPdf(2));
    expect(await step(request({ kind: 'scan', state: { visionPages: [1] } }), job)).toEqual({
      status: 'not_mine',
    });
    expect(
      await step(request({ kind: KIND, pageFrom: 1, pageTo: 2, state: { visionPages: [9] } }), job),
    ).toEqual({
      status: 'ok',
      calls: [],
    });
    expect(await step(request({ kind: KIND, pageFrom: 1, pageTo: 2 }), job)).toEqual({
      status: 'ok',
      calls: [],
    });
    expect(drawn).toEqual([]);
  });

  it('a blank page is not read; a page that cannot be drawn ends the run failed, asking nothing', async () => {
    const blank = await step(
      request({ kind: KIND, pageFrom: 1, pageTo: 3, state: { visionPages: [1, 2] } }),
      jobOf(typedPdf(3, A4, [2])).job,
    );
    expect(inputs(blank.calls).map((c) => c.key)).toEqual(['page-1']);
    expect(blank.warnings).toEqual(['Page 2 is blank, and is not read.']);
    const { job } = jobOf(typedPdf(2), { pdfPictures: async (w) => w.map(() => null) });
    expect(
      await step(request({ kind: KIND, pageFrom: 1, pageTo: 2, state: { visionPages: [2] } }), job),
    ).toEqual({
      status: 'failed',
      warnings: ['Page 2 could not be drawn.'],
    });
  });

  it('reads the marked pages and the option with care', () => {
    expect(
      visionPagesOf({
        visionPages: [3, 1, 3, 0, -1, 1.5, 'x', 12_000, PIPELINE_PAGE_NUMBER_MAX + 1],
      }),
      // A page past 10,000 of a longer book is a page like any (L2).
    ).toEqual([1, 3, 12_000]);
    expect(visionPagesOf(null)).toEqual([]);
    expect(pagesOf({})).toBe(PAGES_DEFAULT);
    expect(pagesOf({ pages: 0 })).toBe(1);
    expect(pagesOf({ pages: 1e9 })).toBe(PIPELINE_ASK_PAGE_MAX);
  });
});
