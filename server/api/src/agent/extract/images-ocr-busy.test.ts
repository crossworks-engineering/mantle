/**
 * The scanned-PDF OCR pass (`ocrIngestPdfNode`) and a busy decode slot.
 *
 * A `PdfBusyError` from the rasterizer (another PDF held the one-at-a-time
 * decode slot past the wait, or this render ran past its hold limit) says
 * nothing about the document. It must fail the extract job so pg-boss
 * retries it, as the pictures pass does (gates.ts). Folded into
 * `rasterizeError` it became the `pdf_unreadable` skip, the job completed,
 * and the scan sat unread until something re-queued it.
 *
 * File bytes, tracing, the document worker and the rasterizer are stubbed;
 * the catch under test is real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  loadFileBytes: vi.fn(),
  runDocumentWorker: vi.fn(),
  rasterizePdfToPngs: vi.fn(),
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
vi.mock('@mantle/files/rasterize', () => ({ rasterizePdfToPngs: h.rasterizePdfToPngs }));
vi.mock('./file-bytes', () => ({ loadFileBytes: h.loadFileBytes }));

import { ocrIngestPdfNode } from './images';

/** Built the way pdf-open.ts builds it: the callers match on `name`. */
function named(name: string, message: string): Error {
  const err = new Error(message);
  Object.defineProperty(err, 'name', { value: name });
  return err;
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

beforeEach(() => {
  vi.clearAllMocks();
  h.loadFileBytes.mockResolvedValue({ bytes: Buffer.from('%PDF-1.4'), filename: 'scan.pdf' });
  // The provider cannot read a PDF natively, so the pass falls through to
  // the rasterizer.
  h.runDocumentWorker.mockResolvedValue({ ran: false, text: '', note: 'no native PDF' });
});

describe('ocrIngestPdfNode: a busy decode slot', () => {
  it('rethrows a PdfBusyError so the job fails and is retried', async () => {
    h.rasterizePdfToPngs.mockRejectedValue(
      named('PdfBusyError', 'another PDF is being decoded; gave up after waiting 600 s'),
    );
    const err = await ocrIngestPdfNode(pdfNode(), 'o1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('PdfBusyError');
  });

  it('still records any other render failure as rasterizeError (pdf_unreadable)', async () => {
    h.rasterizePdfToPngs.mockRejectedValue(new Error('Invalid PDF structure'));
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r).toMatchObject({ text: null, rasterizeError: 'Invalid PDF structure' });
  });

  it('records a PdfLimitError as tooLarge, not a retry', async () => {
    h.rasterizePdfToPngs.mockRejectedValue(named('PdfLimitError', 'PDF pages too large'));
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r).toMatchObject({ text: null, rasterizeError: null, tooLarge: 'PDF pages too large' });
  });
});
