/**
 * The scanned-PDF OCR pass (`ocrIngestPdfNode`) and the parser's answers.
 *
 * The render runs in the parser (POST /pdf/rasterize). What the pass does
 * with each answer:
 *  - the parser busy, or a first refusal (timeout, crash): recorded as
 *    `rasterizeError`, the non-terminal pdf_unreadable skip the drain
 *    retries. The job does not fail.
 *  - `too_large`: a verdict on the document, recorded as `tooLarge`
 *    (pdf_too_large).
 *  - the second refusal of the same bytes (`terminal`): rethrown, so the
 *    caller records document_unreadable.
 * And a retry does not pay for the native read again when it already found
 * nothing in these bytes.
 *
 * File bytes, tracing, the document worker and the parser client are
 * stubbed; the catch under test is real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParserError } from '@mantle/files';

const h = vi.hoisted(() => ({
  loadFileBytes: vi.fn(),
  runDocumentWorker: vi.fn(),
  parserRasterizePdf: vi.fn(),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return { ...actual, db: { ...actual.db, select: vi.fn(), update: vi.fn() } };
});
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return {
    ...actual,
    // Pass-through: the trace bookkeeping isn't what's under test.
    startTrace: vi.fn(async (_init: unknown, fn: () => unknown) => fn()),
    step: vi.fn(async (_spec: unknown, fn: (handle: unknown) => unknown) =>
      fn({ setMeta: () => {} }),
    ),
  };
});
vi.mock('@mantle/runtime/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/runtime/agent')>();
  return { ...actual, runDocumentWorker: h.runDocumentWorker };
});
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return { ...actual, parserRasterizePdf: h.parserRasterizePdf };
});
vi.mock('./file-bytes', () => ({ loadFileBytes: h.loadFileBytes }));

import { ocrIngestPdfNode } from './images';

let seq = 0;
/** Fresh bytes per test, so the native-read memo of one test does not
 *  reach the next. */
function pdfBytes(): Buffer {
  seq += 1;
  return Buffer.from(`%PDF-1.4 test ${seq}`);
}

function pdfNode() {
  return {
    id: 'n1',
    ownerId: 'o1',
    type: 'file',
    title: 'scan.pdf',
    data: { filename: 'scan.pdf', mimeType: 'application/pdf' },
  } as unknown as Parameters<typeof ocrIngestPdfNode>[0];
}

function parserError(code: ParserError['code'], terminal = false): ParserError {
  return new ParserError(code, `parser ${code}`, { retryable: !terminal, terminal });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.loadFileBytes.mockResolvedValue({ bytes: pdfBytes(), filename: 'scan.pdf' });
  // The provider cannot read a PDF natively, so the pass falls through to
  // the render.
  h.runDocumentWorker.mockResolvedValue({ ran: false, text: '', note: 'no native PDF' });
});

describe('ocrIngestPdfNode: the parser render', () => {
  it('records the parser busy as rasterizeError, not a failed job', async () => {
    h.parserRasterizePdf.mockRejectedValue(parserError('busy'));
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r).toMatchObject({ text: null, rasterizeError: 'parser busy' });
  });

  it('records a first timeout as rasterizeError (the drain retries it)', async () => {
    h.parserRasterizePdf.mockRejectedValue(parserError('timeout'));
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r).toMatchObject({ text: null, rasterizeError: 'parser timeout' });
  });

  it('rethrows the second refusal of the same bytes (terminal)', async () => {
    h.parserRasterizePdf.mockRejectedValue(parserError('timeout', true));
    const err = await ocrIngestPdfNode(pdfNode(), 'o1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParserError);
    expect((err as ParserError).terminal).toBe(true);
  });

  it('records too_large as tooLarge, not a retry', async () => {
    h.parserRasterizePdf.mockRejectedValue(parserError('too_large'));
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r).toMatchObject({ text: null, rasterizeError: null, tooLarge: 'parser too_large' });
  });

  it('records any other render failure as rasterizeError (pdf_unreadable)', async () => {
    h.parserRasterizePdf.mockRejectedValue(parserError('failed'));
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r).toMatchObject({ text: null, rasterizeError: 'parser failed' });
  });
});

describe('ocrIngestPdfNode: the native read is paid for once', () => {
  it('skips the native read on a retry of bytes it already found empty', async () => {
    const bytes = pdfBytes();
    h.loadFileBytes.mockResolvedValue({ bytes, filename: 'scan.pdf' });
    h.runDocumentWorker.mockResolvedValue({ ran: true, text: '', note: null, model: 'm' });
    h.parserRasterizePdf.mockRejectedValue(parserError('busy'));

    await ocrIngestPdfNode(pdfNode(), 'o1');
    await ocrIngestPdfNode(pdfNode(), 'o1');

    expect(h.runDocumentWorker).toHaveBeenCalledTimes(1);
    expect(h.parserRasterizePdf).toHaveBeenCalledTimes(2);
  });

  it('runs it again when the first read did not run (no worker that reads PDFs)', async () => {
    const bytes = pdfBytes();
    h.loadFileBytes.mockResolvedValue({ bytes, filename: 'scan.pdf' });
    h.parserRasterizePdf.mockRejectedValue(parserError('busy'));

    await ocrIngestPdfNode(pdfNode(), 'o1');
    await ocrIngestPdfNode(pdfNode(), 'o1');

    expect(h.runDocumentWorker).toHaveBeenCalledTimes(2);
  });
});
