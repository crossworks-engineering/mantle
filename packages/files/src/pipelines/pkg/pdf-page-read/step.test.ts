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
import { BOOK_MIN_PAGES, BOOK_SAMPLE_PAGES, bookOf } from '../../../pdf-kind';
import { PDF_MAX_BYTES } from '../../../pdf-open';
import { renderPdfWindows } from '../../../rasterize';
import { BUILTIN_PIPELINES } from '../../builtin';
import {
  PIPELINE_API,
  PIPELINE_ASK_PAGE_MAX,
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

  it('more than BOOK_MIN_PAGES pages of A4 text or scans is a book; that many, or fewer, is not', () => {
    expect(BOOK_MIN_PAGES).toBe(20);
    expect(bookOf(21, sample(20))).toBe(true);
    expect(bookOf(1679, sample(20, scan))).toBe(true);
    expect(bookOf(20, sample(20))).toBe(false);
    expect(bookOf(null, sample(20))).toBe(false);
  });

  it('a large sheet, a P&ID or an isometric in the sample is a drawing set', () => {
    expect(bookOf(40, [...sample(19), { class: 'scan', size: 'a1' }])).toBe(false);
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

  it('a short file, or a long set of large sheets, takes the page rules', async () => {
    const short = await routerStep(request(), jobOf(typedPdf(BOOK_MIN_PAGES)).job);
    expect(short.kind).toBe('document');
    const large = await routerStep(request(), jobOf(typedPdf(BOOK_MIN_PAGES + 2, A1)).job);
    expect(large.kind).not.toBe('book');
    expect(BOOK_SAMPLE_PAGES).toBe(20);
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
      visionPagesOf({ visionPages: [3, 1, 3, 0, -1, 1.5, 'x', PIPELINE_ASK_PAGE_MAX + 1] }),
    ).toEqual([1, 3]);
    expect(visionPagesOf(null)).toEqual([]);
    expect(pagesOf({})).toBe(PAGES_DEFAULT);
    expect(pagesOf({ pages: 0 })).toBe(1);
    expect(pagesOf({ pages: 1e9 })).toBe(PIPELINE_ASK_PAGE_MAX);
  });
});
