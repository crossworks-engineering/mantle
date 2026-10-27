/**
 * The scanned-PDF OCR pass (`ocrIngestPdfNode`) and the parser's answers.
 *
 * The render runs in the parser (POST /pdf/rasterize). What the pass does
 * with each answer:
 *  - the parser busy or unavailable, or a first refusal (timeout, crash):
 *    rethrown, so the extract job fails and pg-boss retries it (the count
 *    of a refusal is on the node, so the retry's second one is terminal);
 *  - `too_large`: a verdict on the document, recorded as `tooLarge`
 *    (pdf_too_large);
 *  - the second refusal of the same bytes (`terminal`): rethrown, so the
 *    caller records document_unreadable;
 *  - a reader's `failed`: recorded as `rasterizeError`, the non-terminal
 *    pdf_unreadable skip.
 * And the native read is not paid for again when the node says it already
 * found nothing in these bytes (`data.native_pdf.empty_sha256`); a read
 * that found nothing is written there before the render runs (the DB test
 * images-native-empty.db.test.ts follows it through a real database).
 *
 * File bytes, tracing, the document worker and the parser client are
 * stubbed; the catch under test is real.
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParserError } from '@mantle/files';

const h = vi.hoisted(() => ({
  loadFileBytes: vi.fn(),
  runDocumentWorker: vi.fn(),
  parserRasterizePdf: vi.fn(),
  /** What each db.update(...).set(...) was given. */
  sets: [] as unknown[],
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const update = vi.fn(() => ({
    set: (v: unknown) => {
      h.sets.push(v);
      return { where: () => Promise.resolve() };
    },
  }));
  return { ...actual, db: { ...actual.db, select: vi.fn(), update } };
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
/** Fresh bytes per test. */
function pdfBytes(): Buffer {
  seq += 1;
  return Buffer.from(`%PDF-1.4 test ${seq}`);
}

function pdfNode(data: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    ownerId: 'o1',
    type: 'file',
    title: 'scan.pdf',
    data: { filename: 'scan.pdf', mimeType: 'application/pdf', ...data },
  } as unknown as Parameters<typeof ocrIngestPdfNode>[0];
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Whether a value (a drizzle SQL object: circular) holds `want` anywhere. */
function holds(v: unknown, want: string, seen = new Set<unknown>()): boolean {
  if (v === want) return true;
  if (!v || typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  return Object.values(v as Record<string, unknown>).some((x) => holds(x, want, seen));
}

function parserError(code: ParserError['code'], terminal = false): ParserError {
  return new ParserError(code, `parser ${code}`, { retryable: !terminal, terminal });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sets.length = 0;
  h.loadFileBytes.mockResolvedValue({ bytes: pdfBytes(), filename: 'scan.pdf' });
  // The provider cannot read a PDF natively, so the pass falls through to
  // the render.
  h.runDocumentWorker.mockResolvedValue({ ran: false, text: '', note: 'no native PDF' });
});

describe('ocrIngestPdfNode: the parser render', () => {
  for (const code of ['busy', 'unavailable', 'timeout', 'crashed'] as const) {
    it(`rethrows ${code} (retryable): the job fails and pg-boss retries it`, async () => {
      h.parserRasterizePdf.mockRejectedValue(parserError(code));
      const err = await ocrIngestPdfNode(pdfNode(), 'o1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ParserError);
      expect(err).toMatchObject({ code, retryable: true, terminal: false });
    });
  }

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

  it("records a reader's refusal as rasterizeError (pdf_unreadable)", async () => {
    h.parserRasterizePdf.mockRejectedValue(
      new ParserError('failed', 'parser failed', { retryable: false, terminal: false }),
    );
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r).toMatchObject({ text: null, rasterizeError: 'parser failed' });
  });
});

describe('ocrIngestPdfNode: the native read is paid for once', () => {
  it('keeps a read that found nothing on the node, before the render runs', async () => {
    const bytes = pdfBytes();
    h.loadFileBytes.mockResolvedValue({ bytes, filename: 'scan.pdf' });
    h.runDocumentWorker.mockResolvedValue({ ran: true, text: '', note: null, model: 'm' });
    h.parserRasterizePdf.mockRejectedValue(parserError('busy'));

    await ocrIngestPdfNode(pdfNode(), 'o1').catch(() => {});

    expect(h.runDocumentWorker).toHaveBeenCalledTimes(1);
    // One write, the marker: the render failed after it.
    expect(h.sets).toHaveLength(1);
    expect(holds(h.sets[0], sha256(bytes))).toBe(true);
  });

  it('skips the native read when the node says these bytes were read and found empty', async () => {
    const bytes = pdfBytes();
    h.loadFileBytes.mockResolvedValue({ bytes, filename: 'scan.pdf' });
    h.parserRasterizePdf.mockRejectedValue(parserError('busy'));

    await ocrIngestPdfNode(pdfNode({ native_pdf: { empty_sha256: sha256(bytes) } }), 'o1').catch(
      () => {},
    );

    expect(h.runDocumentWorker).not.toHaveBeenCalled();
    expect(h.parserRasterizePdf).toHaveBeenCalledTimes(1);
    expect(h.sets).toHaveLength(0);
  });

  it('reads again when the marker is for other bytes', async () => {
    const bytes = pdfBytes();
    h.loadFileBytes.mockResolvedValue({ bytes, filename: 'scan.pdf' });
    h.parserRasterizePdf.mockRejectedValue(parserError('busy'));

    await ocrIngestPdfNode(pdfNode({ native_pdf: { empty_sha256: 'f'.repeat(64) } }), 'o1').catch(
      () => {},
    );

    expect(h.runDocumentWorker).toHaveBeenCalledTimes(1);
  });

  it('runs it again when the first read did not run (no worker that reads PDFs)', async () => {
    const bytes = pdfBytes();
    h.loadFileBytes.mockResolvedValue({ bytes, filename: 'scan.pdf' });
    h.parserRasterizePdf.mockRejectedValue(parserError('busy'));

    await ocrIngestPdfNode(pdfNode(), 'o1').catch(() => {});
    await ocrIngestPdfNode(pdfNode(), 'o1').catch(() => {});

    expect(h.runDocumentWorker).toHaveBeenCalledTimes(2);
    expect(h.sets).toHaveLength(0);
  });
});
