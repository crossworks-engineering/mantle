/**
 * The scanned-PDF read (`ocrIngestPdfNode`: the Scan reader, page by page,
 * @mantle/runtime readScannedPdf) and the parser's answers, and the native
 * read of a typed PDF (`nativeReadPdfNode`).
 *
 * What the scan pass does with each answer of the parser:
 *  - busy or unavailable, or a first refusal (timeout, crash): rethrown, so
 *    the extract job fails and pg-boss retries it (the count of a refusal is
 *    on the node, so the retry's second one is terminal);
 *  - the second refusal of the same bytes (`terminal`): rethrown, so the
 *    caller records document_unreadable;
 *  - `too_large`: a verdict on the document, `tooLarge` (pdf_too_large);
 *  - a password: `encrypted`;
 *  - a reader's `failed`: `rasterizeError`, the non-terminal pdf_unreadable.
 * And the pages each window read are kept on the node (`data.ocr.resume`),
 * so a retry goes on after them and pays for no page twice; the end puts
 * the final `ocr` (true, or the pages read and unread by why) in its place.
 *
 * File bytes, tracing, the workers and the page read are stubbed; the
 * branching under test is real.
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParserError } from '@mantle/files';
import type { ScanPage } from '@mantle/runtime/agent';

const h = vi.hoisted(() => ({
  loadFileBytes: vi.fn(),
  runDocumentWorker: vi.fn(),
  readScannedPdf: vi.fn(),
  /** The node's shared reads (scan-share.ts), as the store would give them. */
  share: null as null | { total?: number; pages: Record<string, [string, string, string]> },
  hooks: { claim: vi.fn(), keep: vi.fn(), wait: vi.fn() },
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
  return {
    ...actual,
    runDocumentWorker: h.runDocumentWorker,
    readScannedPdf: h.readScannedPdf,
    scanShareOf: vi.fn(async () => (h.share ? { sha256: 's', claims: {}, ...h.share } : null)),
    scanKeptOf: vi.fn(async () => {
      const m = new Map<number, ScanPage>();
      for (const [k, [method, why, text]] of Object.entries(h.share?.pages ?? {})) {
        m.set(Number(k), {
          page: Number(k),
          method: method as ScanPage['method'],
          text,
          ...(why ? { why: why as ScanPage['why'] } : {}),
        });
      }
      return m;
    }),
    scanShareHooks: vi.fn(() => h.hooks),
  };
});
vi.mock('./file-bytes', () => ({ loadFileBytes: h.loadFileBytes }));

import { nativeReadPdfNode, ocrIngestPdfNode } from './images';

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
  if (typeof v === 'string' && v.includes(want)) return true;
  if (!v || typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  return Object.values(v as Record<string, unknown>).some((x) => holds(x, want, seen));
}

function parserError(code: ParserError['code'], terminal = false): ParserError {
  return new ParserError(code, `parser ${code}`, { retryable: !terminal, terminal });
}

const page = (n: number, method: ScanPage['method'], text = '', why?: ScanPage['why']) =>
  ({ page: n, method, text, ...(why ? { why } : {}) }) as ScanPage;

let bytes: Buffer;
beforeEach(() => {
  vi.clearAllMocks();
  h.sets.length = 0;
  h.share = null;
  bytes = pdfBytes();
  h.loadFileBytes.mockResolvedValue({ bytes, filename: 'scan.pdf' });
});

describe('ocrIngestPdfNode: the parser', () => {
  for (const code of ['busy', 'unavailable', 'timeout', 'crashed'] as const) {
    it(`rethrows ${code} (retryable): the job fails and pg-boss retries it`, async () => {
      h.readScannedPdf.mockRejectedValue(parserError(code));
      const err = await ocrIngestPdfNode(pdfNode(), 'o1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ParserError);
      expect(err).toMatchObject({ code, retryable: true, terminal: false });
    });
  }

  it('rethrows the second refusal of the same bytes (terminal)', async () => {
    h.readScannedPdf.mockRejectedValue(parserError('timeout', true));
    const err = await ocrIngestPdfNode(pdfNode(), 'o1').catch((e: unknown) => e);
    expect((err as ParserError).terminal).toBe(true);
  });

  it('records too_large as tooLarge, not a retry', async () => {
    h.readScannedPdf.mockRejectedValue(
      new ParserError('too_large', 'parser too_large', { retryable: false, terminal: false }),
    );
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r).toMatchObject({ text: null, rasterizeError: null, tooLarge: 'parser too_large' });
  });

  it('records a password as encrypted', async () => {
    h.readScannedPdf.mockRejectedValue(
      new ParserError('failed', 'qpdf: invalid password', { retryable: false, terminal: false }),
    );
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r).toMatchObject({ text: null, encrypted: true, rasterizeError: null });
  });

  it("records a reader's refusal as rasterizeError (pdf_unreadable)", async () => {
    h.readScannedPdf.mockRejectedValue(
      new ParserError('failed', 'parser failed', { retryable: false, terminal: false }),
    );
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r).toMatchObject({ text: null, rasterizeError: 'parser failed' });
  });

  it('rethrows an error that is not the parser’s', async () => {
    h.readScannedPdf.mockRejectedValue(new Error('db down'));
    await expect(ocrIngestPdfNode(pdfNode(), 'o1')).rejects.toThrow('db down');
  });
});

describe('ocrIngestPdfNode: the pages and their record', () => {
  it('reads every page, with no cap, and marks a whole read `ocr: true`', async () => {
    const pages = Array.from({ length: 25 }, (_, i) => page(i + 1, 'scan_reader', `text ${i + 1}`));
    h.readScannedPdf.mockResolvedValue({ pages, pagesTotal: 25, ran: true, model: 'm' });
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r.text).toContain('[Page 25]\ntext 25');
    expect(r).toMatchObject({ ran: true, pagesTotal: 25 });
    expect(r.unread).toBeUndefined();
    const last = h.sets[h.sets.length - 1];
    expect(holds(last, 'scan_reader:mistral-ocr')).toBe(true);
  });

  it('says the pages unread by why, so the file shows partial', async () => {
    h.readScannedPdf.mockResolvedValue({
      pages: [page(1, 'scan_reader', 'one'), page(2, 'unread', '', 'bad_read'), page(3, 'blank')],
      pagesTotal: 3,
      ran: true,
      model: 'm',
    });
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r.unread).toEqual({ bad_read: 1 });
    const last = h.sets[h.sets.length - 1];
    expect(holds(last, '"pages_read":2')).toBe(true);
    expect(holds(last, '"bad_read":1')).toBe(true);
  });

  it('reads with the shared reads of the node: claimed, kept, waited for', async () => {
    h.readScannedPdf.mockResolvedValue({ pages: [], pagesTotal: 1, ran: false, model: null });
    await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(h.readScannedPdf.mock.calls[0]![0]).toMatchObject({ share: h.hooks });
  });

  it('goes on after the pages kept before (a try before, or a chat turn), and pays for none again', async () => {
    h.share = {
      total: 3,
      pages: { '1': ['scan_reader', '', 'kept one'], '2': ['unread', 'bad_read', ''] },
    };
    h.readScannedPdf.mockResolvedValue({
      pages: [page(3, 'scan_reader', 'three')],
      pagesTotal: 3,
      ran: true,
      model: 'm',
    });
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(h.readScannedPdf).toHaveBeenCalledWith(
      expect.objectContaining({ done: new Set([1, 2]), pagesTotal: 3 }),
    );
    expect(r.text).toBe('[Page 1]\nkept one\n\n[Page 3]\nthree');
    expect(r.unread).toEqual({ bad_read: 1 });
  });

  it('starts from page 1 when nothing is kept', async () => {
    h.readScannedPdf.mockResolvedValue({ pages: [], pagesTotal: 1, ran: false, model: null });
    await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(h.readScannedPdf.mock.calls[0]![0]).not.toHaveProperty('done');
  });

  it('keeps the shared pages beside the final mark while a chat turn reads them', async () => {
    h.readScannedPdf.mockResolvedValue({
      pages: [page(1, 'scan_reader', 'one')],
      pagesTotal: 1,
      ran: true,
      model: 'm',
    });
    await ocrIngestPdfNode(pdfNode(), 'o1');
    const last = h.sets[h.sets.length - 1];
    expect(holds(last, 'chat_until')).toBe(true);
    expect(holds(last, '"pages_read":1')).toBe(true);
  });

  it('a white page beside pages with no Scan reader is no verdict: read again, pages kept', async () => {
    h.readScannedPdf.mockResolvedValue({
      pages: [page(1, 'blank'), page(2, 'unread', '', 'no_scan_reader')],
      pagesTotal: 2,
      ran: false,
      model: null,
    });
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r).toMatchObject({ text: null, ran: false, unread: { no_scan_reader: 1 } });
    // Nothing removed: the kept pages stay for the read again.
    expect(h.sets).toHaveLength(0);
  });

  it('a figure vision could not describe is a verdict: no read again pays for it', async () => {
    h.readScannedPdf.mockResolvedValue({
      pages: [page(1, 'unread', '', 'figure')],
      pagesTotal: 1,
      ran: true,
      model: 'm',
    });
    expect(await ocrIngestPdfNode(pdfNode(), 'o1')).toMatchObject({ text: null, ran: true });
  });

  it('a white file is a verdict (terminal), no Scan reader is none (read again)', async () => {
    h.readScannedPdf.mockResolvedValue({
      pages: [page(1, 'blank'), page(2, 'blank')],
      pagesTotal: 2,
      ran: false,
      model: null,
    });
    expect(await ocrIngestPdfNode(pdfNode(), 'o1')).toMatchObject({ text: null, ran: true });

    h.readScannedPdf.mockResolvedValue({
      pages: [page(1, 'unread', '', 'no_scan_reader')],
      pagesTotal: 1,
      ran: false,
      model: null,
    });
    expect(await ocrIngestPdfNode(pdfNode(), 'o1')).toMatchObject({
      text: null,
      ran: false,
      unread: { no_scan_reader: 1 },
    });
  });

  it('every scanned page too large is the terminal tooLarge', async () => {
    h.readScannedPdf.mockResolvedValue({
      pages: [page(1, 'unread', '', 'too_large'), page(2, 'blank')],
      pagesTotal: 2,
      ran: false,
      model: null,
    });
    const r = await ocrIngestPdfNode(pdfNode(), 'o1');
    expect(r.tooLarge).toMatch(/too large|past the size/);
  });
});

describe('nativeReadPdfNode: a typed PDF read through the model, paid for once', () => {
  it('keeps a read that found nothing on the node', async () => {
    h.runDocumentWorker.mockResolvedValue({ ran: true, text: '', note: null, model: 'm' });
    expect(await nativeReadPdfNode(pdfNode(), 'o1')).toEqual({ text: null });
    expect(h.sets).toHaveLength(1);
    expect(holds(h.sets[0], sha256(bytes))).toBe(true);
  });

  it('skips the read when the node says these bytes were read and found empty', async () => {
    await nativeReadPdfNode(pdfNode({ native_pdf: { empty_sha256: sha256(bytes) } }), 'o1');
    expect(h.runDocumentWorker).not.toHaveBeenCalled();
  });

  it('reads again when the marker is for other bytes, or the read did not run', async () => {
    h.runDocumentWorker.mockResolvedValue({ ran: false, text: '', note: 'no native PDF' });
    await nativeReadPdfNode(pdfNode({ native_pdf: { empty_sha256: 'f'.repeat(64) } }), 'o1');
    await nativeReadPdfNode(pdfNode(), 'o1');
    expect(h.runDocumentWorker).toHaveBeenCalledTimes(2);
    expect(h.sets).toHaveLength(0);
  });

  it('persists and returns the text it read', async () => {
    h.runDocumentWorker.mockResolvedValue({
      ran: true,
      text: 'Typed text.',
      note: null,
      model: 'm',
    });
    expect(await nativeReadPdfNode(pdfNode(), 'o1')).toEqual({ text: 'Typed text.' });
    expect(h.sets).toHaveLength(1);
  });
});
