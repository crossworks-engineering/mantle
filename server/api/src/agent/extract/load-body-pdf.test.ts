/**
 * The PDF dead-ends in `loadExtractableBody`, and which disposition each one
 * records.
 *
 * A scanned PDF that yields no text can fail for four quite different reasons,
 * and the only thing the operator ever sees is the disposition on the skipped
 * trace. Collapsing them is not a cosmetic problem: each one implies a
 * different repair, and three of the four are NOT "the document is blank".
 *
 *   encrypted_pdf   — locked; add the password
 *   bytes_unavailable — we never had the file; re-fetch it
 *   pdf_unreadable  — the rasterizer threw; the PIPELINE is broken, not the file
 *   no_text_layer   — genuinely nothing to read, or no vision worker wired up
 *
 * `pdf_unreadable` is the one this file was added for. A throw inside the
 * rasterize step used to be swallowed into `pages: 0`, which is indistinguishable
 * from a blank scan, so a broken PDF pipeline reported `no_text_layer` and told
 * the operator to go configure a vision worker that was fine. The nastiest
 * instance is a second pdfjs in the process (see
 * `packages/files/src/pdf-stack.test.ts`): it fails EVERY PDF for the life of
 * the worker, and under the old behaviour it did so silently.
 *
 * The node loader, file bytes, tracing and the OCR pass itself are stubbed;
 * the branching under test is real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  recordSkippedTrace: vi.fn(),
  ocrIngestPdfNode: vi.fn(),
  loadFileBytes: vi.fn(),
  tryUnlockPdf: vi.fn(),
  documentWorkerPrefersNative: vi.fn(),
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
vi.mock('./file-bytes', () => ({
  loadFileBytes: h.loadFileBytes,
  tryUnlockPdf: h.tryUnlockPdf,
}));
vi.mock('./images', () => ({
  ocrIngestPdfNode: h.ocrIngestPdfNode,
  composeImageBody: vi.fn(),
  visionIngestImageNode: vi.fn(),
}));

import { loadExtractableBody } from './load-body';

const WORKER = { id: 'w1', slug: 'extractor', params: {}, apiKeyId: null };

/** A scanned-PDF file node: no stored text, and (with `loadFileBytes` stubbed
 *  to null) a body that falls back to the title — which is what puts
 *  `loadExtractableBody` on the `isPdfWithoutTextLayer` branch. */
function pdfNode() {
  return {
    id: 'n1',
    ownerId: 'o1',
    type: 'file',
    title: 'scan.pdf',
    tags: [],
    data: { filename: 'scan.pdf', mimeType: 'application/pdf' },
    embedding: null,
    parentId: null,
  } as unknown as Parameters<typeof loadExtractableBody>[0];
}

/** The one skipped trace recorded, as `[disposition, details]`. */
function skip(): [string | undefined, Record<string, unknown>] {
  const call = h.recordSkippedTrace.mock.calls[0]?.[0] as
    { disposition?: string; details?: Record<string, unknown> } | undefined;
  return [call?.disposition, call?.details ?? {}];
}

async function run() {
  return await loadExtractableBody(pdfNode(), 'o1', WORKER as never, {
    filename: 'scan.pdf',
    mimeType: 'application/pdf',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.recordSkippedTrace.mockResolvedValue(undefined);
  h.loadFileBytes.mockResolvedValue(null);
  h.tryUnlockPdf.mockResolvedValue(null);
  h.documentWorkerPrefersNative.mockResolvedValue(false);
});

describe('loadExtractableBody — PDF dead-ends', () => {
  it('reports a rasterize failure as pdf_unreadable, carrying the error', async () => {
    h.ocrIngestPdfNode.mockResolvedValue({
      text: null,
      encrypted: false,
      bytesMissing: false,
      rasterizeError: 'The API version "6.2.108" does not match the Worker version "5.4.296".',
    });

    const res = await run();
    expect(res.ok).toBe(false);

    const [disposition, details] = skip();
    expect(disposition).toBe('pdf_unreadable');
    // The message is the whole diagnosis — it must survive into the trace, or
    // the operator is back to guessing which of the four things went wrong.
    expect(details.error).toContain('does not match the Worker version');
    expect(String(details.hint)).toMatch(/not a verdict on the document/i);
  });

  it('does not blame the document: a rasterize failure is never no_text_layer', async () => {
    h.ocrIngestPdfNode.mockResolvedValue({
      text: null,
      encrypted: false,
      bytesMissing: false,
      rasterizeError: 'Cannot find module @napi-rs/canvas-linux-x64-gnu',
    });

    await run();
    const [disposition, details] = skip();
    expect(disposition).not.toBe('no_text_layer');
    // The old hint sent people to the vision-worker settings page for a fault
    // that has nothing to do with the vision worker.
    expect(String(details.hint)).not.toMatch(/settings\/ai-workers/);
  });

  it('still reports a genuinely blank scan as no_text_layer', async () => {
    h.ocrIngestPdfNode.mockResolvedValue({
      text: null,
      encrypted: false,
      bytesMissing: false,
      rasterizeError: null,
    });

    await run();
    expect(skip()[0]).toBe('no_text_layer');
  });

  it('keeps encrypted_pdf ahead of the new branch', async () => {
    // A password failure sets `encrypted`, not `rasterizeError` — but pin the
    // precedence anyway, since both can be truthy in principle and "locked" is
    // the more actionable answer.
    h.ocrIngestPdfNode.mockResolvedValue({
      text: null,
      encrypted: true,
      bytesMissing: false,
      rasterizeError: 'PasswordException: No password given',
    });

    await run();
    expect(skip()[0]).toBe('encrypted_pdf');
  });

  it('keeps bytes_unavailable ahead of the new branch', async () => {
    h.ocrIngestPdfNode.mockResolvedValue({
      text: null,
      encrypted: false,
      bytesMissing: true,
      rasterizeError: null,
    });

    await run();
    expect(skip()[0]).toBe('bytes_unavailable');
  });

  it('records nothing when OCR succeeds', async () => {
    h.ocrIngestPdfNode.mockResolvedValue({
      text: 'a'.repeat(50),
      encrypted: false,
      bytesMissing: false,
      rasterizeError: null,
    });

    const res = await run();
    expect(res.ok).toBe(true);
    expect(h.recordSkippedTrace).not.toHaveBeenCalled();
  });
});
