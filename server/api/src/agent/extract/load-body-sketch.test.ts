/**
 * The sketch read of a scanned drawing inside `loadExtractableBody` (M3 audit
 * round 1, finding M3-1). The read is paid for once for a file's bytes, so
 * its text is stored on the node at once: a retry of the extract (the
 * extraction model failed after this point) finds the text there and runs
 * no whole-page read on top. A PDF with a text layer keeps its own text with
 * the scan's text after it; a sketch read that gave no text ends as any
 * blank scan does.
 *
 * The sketch read, the OCR pass, the file bytes and tracing are stubbed; the
 * branching under test is real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  recordSkippedTrace: vi.fn(),
  ocrIngestPdfNode: vi.fn(),
  loadFileBytes: vi.fn(),
  tryUnlockPdf: vi.fn(),
  documentWorkerPrefersNative: vi.fn(),
  parseDocumentBytes: vi.fn(),
  sketchIngestPdfNode: vi.fn(),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return { ...actual, db: { ...actual.db, select: vi.fn(), update: vi.fn() } };
});
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return {
    ...actual,
    recordSkippedTrace: h.recordSkippedTrace,
    // Pass-through: the steps' bookkeeping isn't what's under test.
    step: vi.fn(async (_spec: unknown, fn: (handle: unknown) => unknown) =>
      fn({ setMeta: () => {} }),
    ),
  };
});
vi.mock('@mantle/runtime/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/runtime/agent')>();
  return { ...actual, documentWorkerPrefersNative: h.documentWorkerPrefersNative };
});
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return { ...actual, parseDocumentBytes: h.parseDocumentBytes };
});
vi.mock('./file-bytes', () => ({
  loadFileBytes: h.loadFileBytes,
  tryUnlockPdf: h.tryUnlockPdf,
}));
vi.mock('./images', () => ({
  ocrIngestPdfNode: h.ocrIngestPdfNode,
  composeImageBody: vi.fn(),
  visionIngestImageNode: vi.fn(),
}));

vi.mock('./pdf-sketch', () => ({ sketchIngestPdfNode: h.sketchIngestPdfNode }));

import { loadExtractableBody } from './load-body';

const WORKER = { id: 'w1', slug: 'extractor', params: {}, apiKeyId: null };
const SKETCH = 'U2-E-12A heat exchanger, 4"-P-1001-A1A to FIC-101, made up';

function pdfNode(data: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    ownerId: 'o1',
    type: 'file',
    title: 'scan.pdf',
    tags: [],
    data: { filename: 'scan.pdf', mimeType: 'application/pdf', ...data },
    embedding: null,
    parentId: null,
  } as unknown as Parameters<typeof loadExtractableBody>[0];
}

async function run(data: Record<string, unknown> = {}) {
  return await loadExtractableBody(pdfNode(data), 'o1', WORKER as never, {
    filename: 'scan.pdf',
    mimeType: 'application/pdf',
    ...data,
  });
}

/** What the store step wrote: the `set` calls of `db.update`. */
const sets: unknown[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  sets.length = 0;
  h.recordSkippedTrace.mockResolvedValue(undefined);
  h.loadFileBytes.mockResolvedValue(null);
  h.tryUnlockPdf.mockResolvedValue(null);
  h.documentWorkerPrefersNative.mockResolvedValue(false);
  h.sketchIngestPdfNode.mockResolvedValue(null);
  const { db } = await import('@mantle/db');
  vi.mocked(db.update).mockReturnValue({
    set: (v: unknown) => {
      sets.push(v);
      return { where: async () => undefined };
    },
  } as never);
});

describe('loadExtractableBody: the sketch read of a scanned drawing', () => {
  it('a scan: the sketch text is the body, stored at once, and no whole-page read runs', async () => {
    h.sketchIngestPdfNode.mockResolvedValue({ text: SKETCH });
    const res = await run();
    expect(res).toEqual({ ok: true, rawBody: SKETCH });
    expect(h.ocrIngestPdfNode).not.toHaveBeenCalled();
    // Stored before the extraction model runs: one write, the text with it.
    expect(sets).toHaveLength(1);
  });

  it('a retry after the extract failed: the stored text is the body, no read runs again', async () => {
    // The first pass stored the text, and the database holds the mark: the
    // sketch read gives null now.
    const res = await run({ text: SKETCH, ocr: true });
    expect(res).toEqual({ ok: true, rawBody: SKETCH });
    expect(h.ocrIngestPdfNode).not.toHaveBeenCalled();
    expect(h.loadFileBytes).not.toHaveBeenCalled();
    expect(sets).toHaveLength(0);
  });

  it('a PDF with a text layer keeps its text, with the scan text after it', async () => {
    h.loadFileBytes.mockResolvedValue({
      bytes: Buffer.from('%PDF-1.7'),
      ext: 'pdf',
      filename: 'scan.pdf',
    });
    h.parseDocumentBytes.mockResolvedValue('Title block text of the sheet, revision B, made up');
    h.sketchIngestPdfNode.mockResolvedValue({ text: SKETCH });
    const res = await run();
    expect(res.ok).toBe(true);
    const body = (res as { rawBody: string }).rawBody;
    expect(body.indexOf('Title block text')).toBe(0);
    expect(body).toContain(SKETCH);
    expect(h.ocrIngestPdfNode).not.toHaveBeenCalled();
    expect(sets).toHaveLength(1);
  });

  it('a sketch read with no text ends as a blank scan: no_text_layer, no whole-page read', async () => {
    h.sketchIngestPdfNode.mockResolvedValue({ text: '' });
    const res = await run();
    expect(res.ok).toBe(false);
    expect(h.ocrIngestPdfNode).not.toHaveBeenCalled();
    const call = h.recordSkippedTrace.mock.calls[0]?.[0] as { disposition?: string } | undefined;
    expect(call?.disposition).toBe('no_text_layer');
    // Terminal, as any blank scan: the node is stamped, not queued again.
    expect(sets).toHaveLength(1);
  });
});
