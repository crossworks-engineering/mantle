/**
 * The router on a long office PDF whose first pages do not look like a book
 * (the VCC spec book): a spec document of 682 A4 pages, its first 20 holding
 * 3 damaged pages and 6 drawn table pages with a text layer (`vector_text`),
 * the rest scanned text with some scanned ruled table grids (kind `scan`).
 * The sample of the first 20 pages is no book (11 of 17 pages read are typed
 * or scanned), but the whole file is: the router names it a book, with no
 * ask, from the read of all its pages. Before, a long file was a book only by
 * its sample, and this one got the kind the page rules gave its ruled scans.
 *
 * The page reader is faked: the page facts are made here, shaped like that
 * file's (no client data). The step itself is real.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PdfDrawing, PdfDrawingPage } from '../../../pdf-drawing';
import { BOOK_SAMPLE_PAGES, bookOf } from '../../../pdf-kind';
import type { PipelineStepRequest, StepJob } from '../../contract';

const PAGES = 682;

/** One page row as the reader gives it, on A4 paper. */
function page(n: number, cls: PdfDrawingPage['class'], kind: PdfDrawingPage['kind']) {
  const ocr = cls === 'scan_hidden_text';
  return {
    page: n,
    status: cls ? 'ok' : 'failed',
    ...(cls ? { class: cls, size: 'a4' as const } : { why: 'damaged' }),
    chars: cls === 'text' || cls === 'vector_text' || ocr ? 1800 : 0,
    runs: 0,
    hiddenShare: ocr ? 1 : 0,
    imageCover: cls === 'scan' || ocr ? 1 : 0,
    segments: cls === 'vector_text' ? 400 : 0,
    axes: null,
    tagLike: 0,
    instruments: 0,
    lineNumbers: 0,
    markups: 0,
    markupsWithText: 0,
    readMs: 1,
    kind,
    kindFrom: 'rules',
    eye: null,
  } as unknown as PdfDrawingPage;
}

/** The whole file: pages 1-3 damaged, 4-9 drawn tables with a text layer,
 *  then scanned text, every tenth page a scanned ruled table grid. */
const ALL: PdfDrawingPage[] = Array.from({ length: PAGES }, (_, i) => {
  const n = i + 1;
  if (n <= 3) return page(n, undefined, 'none');
  if (n <= 9) return page(n, 'vector_text', 'other_drawing');
  if (n % 10 === 0) return page(n, 'scan', 'scan');
  return page(n, 'scan', 'document');
});

/** A second spec addendum (rules 6), its counts on made-up pages:
 *  pages 1-3 damaged, 4-70 drawn tables with a text layer, 10 typed pages,
 *  then OCR'd scans (`scan_hidden_text`) the eye's few looks named ruled
 *  (kind `scan`), 3 of them `document`. */
const OCR: PdfDrawingPage[] = Array.from({ length: PAGES }, (_, i) => {
  const n = i + 1;
  if (n <= 3) return page(n, undefined, 'none');
  if (n <= 70) return page(n, 'vector_text', 'unsure');
  if (n <= 80) return page(n, 'text', 'document');
  if (n <= 83) return page(n, 'scan_hidden_text', 'document');
  return page(n, 'scan_hidden_text', 'scan');
});

/** The pages the faked reader gives: one of the two files. */
let current = ALL;

const drawingOf = (pages: PdfDrawingPage[]): PdfDrawing => ({
  numPages: PAGES,
  pageCountMayBeShort: false,
  // What the page rules named the file: its ruled scans.
  kind: 'scan',
  pages,
  sample: '',
  allRead: false,
  largeImageNotRead: false,
});

vi.mock('../../../pdf-drawing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../pdf-drawing')>();
  return {
    ...actual,
    readPdfDrawingInJob: async (_b: Buffer, _j: unknown, _box: unknown, max?: number) =>
      drawingOf(max === undefined ? current : current.slice(0, max)),
  };
});

const { step } = await import('./step');

const job = {
  bytes: async () => Buffer.from('%PDF-1.7 made up'),
  pdfPageCount: async () => PAGES,
} as unknown as StepJob;

const request = (asks: boolean): PipelineStepRequest => ({
  api: 1,
  step: 1,
  file: { name: 'spec.pdf', ext: 'pdf', size: 40_000_000, sha256: 'x' },
  options: {},
  asks,
});

describe('a long office PDF whose first pages are no book', () => {
  it('the facts are shaped as that file: the sample fails, the whole file passes', () => {
    expect(bookOf(PAGES, ALL.slice(0, BOOK_SAMPLE_PAGES))).toBe(false);
    expect(bookOf(PAGES, ALL)).toBe(true);
  });

  it('is a book, by its pages read whole, with no ask', async () => {
    for (const asks of [false, true]) {
      const r = await step(request(asks), job);
      expect(r, `asks ${asks}`).toEqual({ status: 'ok', kind: 'book' });
    }
  });
});

describe("a long office PDF of OCR'd A4 scans (rules 6)", () => {
  it('the facts are shaped as that file: 599 OCR pages of kind scan, still a book', () => {
    expect(OCR.filter((p) => p.class === 'scan_hidden_text' && p.kind === 'scan')).toHaveLength(
      599,
    );
    expect(bookOf(PAGES, OCR.slice(0, BOOK_SAMPLE_PAGES))).toBe(false);
    expect(bookOf(PAGES, OCR)).toBe(true);
  });

  it('is a book, with no ask', async () => {
    current = OCR;
    try {
      for (const asks of [false, true]) {
        const r = await step(request(asks), job);
        expect(r, `asks ${asks}`).toEqual({ status: 'ok', kind: 'book' });
      }
    } finally {
      current = ALL;
    }
  });
});
