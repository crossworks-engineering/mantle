/**
 * Which body dead-ends are TERMINAL (stamped `data.extract_skipped`, so the
 * boot drain and the provider recovery drain stop re-queuing the node) and
 * which are left for the drain to retry.
 *
 * NATREF, 2026-10-04: an .exe file (`no_parser`) had 16 extract jobs in 3
 * days, re-queued by every restart and every provider recovery, because a
 * skip left no mark the drain could see. A content verdict is terminal; a
 * worker that did not run is not, or a provider outage would lock an image
 * out of the brain for good.
 *
 * The node loader, file bytes, tracing, the vision/OCR passes and the stamp
 * are stubbed; the branching under test is real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  recordSkippedTrace: vi.fn(),
  recordTerminalSkip: vi.fn(),
  ocrIngestPdfNode: vi.fn(),
  visionIngestImageNode: vi.fn(),
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
    step: vi.fn(async (_spec: unknown, fn: (handle: unknown) => unknown) =>
      fn({ setMeta: () => {} }),
    ),
  };
});
vi.mock('@mantle/runtime/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/runtime/agent')>();
  return { ...actual, documentWorkerPrefersNative: h.documentWorkerPrefersNative };
});
vi.mock('./file-bytes', () => ({ loadFileBytes: h.loadFileBytes, tryUnlockPdf: h.tryUnlockPdf }));
vi.mock('./images', () => ({
  ocrIngestPdfNode: h.ocrIngestPdfNode,
  visionIngestImageNode: h.visionIngestImageNode,
  composeImageBody: vi.fn((_d: unknown, text: string) => text),
}));
vi.mock('./terminal', () => ({ recordTerminalSkip: h.recordTerminalSkip }));

import { loadExtractableBody } from './load-body';

const WORKER = { id: 'w1', slug: 'extractor', params: {}, apiKeyId: null };

function fileNode(filename: string, mimeType: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    ownerId: 'o1',
    type: 'file',
    title: filename,
    tags: [],
    data: { filename, mimeType, ...extra },
    embedding: null,
    parentId: null,
  } as unknown as Parameters<typeof loadExtractableBody>[0];
}

async function run(node: Parameters<typeof loadExtractableBody>[0]) {
  return await loadExtractableBody(
    node,
    'o1',
    WORKER as never,
    (node.data ?? {}) as Record<string, unknown>,
  );
}

/** Disposition of the terminal skip, or of the plain one, recorded. */
const terminal = () =>
  (h.recordTerminalSkip.mock.calls[0]?.[0] as { disposition?: string } | undefined)?.disposition;
const plain = () =>
  (h.recordSkippedTrace.mock.calls[0]?.[0] as { disposition?: string } | undefined)?.disposition;

beforeEach(() => {
  vi.clearAllMocks();
  h.recordSkippedTrace.mockResolvedValue(undefined);
  h.recordTerminalSkip.mockResolvedValue(undefined);
  h.loadFileBytes.mockResolvedValue(null);
  h.tryUnlockPdf.mockResolvedValue(null);
  h.documentWorkerPrefersNative.mockResolvedValue(false);
});

describe('loadExtractableBody: terminal skips', () => {
  it('stamps a file no parser reads (the NATREF .exe) terminal', async () => {
    const res = await run(fileNode('setup-tool-installer-v2.exe', 'application/octet-stream'));
    expect(res.ok).toBe(false);
    expect(terminal()).toBe('no_parser');
    expect(h.recordSkippedTrace).not.toHaveBeenCalled();
  });

  it('stamps a body under the minimum terminal', async () => {
    const res = await run({
      ...fileNode('x', 'text/plain'),
      type: 'note',
      title: 'Short',
      data: { content: 'ok then' },
    } as never);
    expect(res.ok).toBe(false);
    expect(terminal()).toBe('body_too_short');
  });

  it('stamps media terminal', async () => {
    await run(fileNode('standup.mp4', 'video/mp4'));
    expect(terminal()).toBe('unsupported_media');
  });

  it('still sends an image through vision first', async () => {
    h.visionIngestImageNode.mockResolvedValue({
      text: 'A site plan with three buildings and a car park.',
      failure: null,
      ran: true,
    });
    const res = await run(fileNode('plan.png', 'image/png'));
    expect(h.visionIngestImageNode).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(h.recordTerminalSkip).not.toHaveBeenCalled();
  });

  it('stamps an image terminal when the vision worker ran and saw nothing', async () => {
    h.visionIngestImageNode.mockResolvedValue({ text: null, failure: 'empty', ran: true });
    await run(fileNode('blank.png', 'image/png'));
    expect(terminal()).toBe('no_vision_text');
  });

  it('leaves an image for the drain when the vision worker did not run', async () => {
    h.visionIngestImageNode.mockResolvedValue({ text: null, failure: '503', ran: false });
    await run(fileNode('plan.png', 'image/png'));
    expect(plain()).toBe('no_vision_text');
    expect(h.recordTerminalSkip).not.toHaveBeenCalled();
  });

  it('stamps a blank scan terminal only when OCR really ran', async () => {
    const ocr = { text: null, encrypted: false, bytesMissing: false, rasterizeError: null };
    h.ocrIngestPdfNode.mockResolvedValue({ ...ocr, ran: true });
    await run(fileNode('scan.pdf', 'application/pdf'));
    expect(terminal()).toBe('no_text_layer');

    vi.clearAllMocks();
    h.ocrIngestPdfNode.mockResolvedValue({ ...ocr, ran: false });
    await run(fileNode('scan.pdf', 'application/pdf'));
    expect(plain()).toBe('no_text_layer');
    expect(h.recordTerminalSkip).not.toHaveBeenCalled();
  });

  it('leaves a rasterizer failure for the drain (the pipeline, not the file)', async () => {
    h.ocrIngestPdfNode.mockResolvedValue({
      text: null,
      encrypted: false,
      bytesMissing: false,
      rasterizeError: 'boom',
      ran: false,
    });
    await run(fileNode('scan.pdf', 'application/pdf'));
    expect(plain()).toBe('pdf_unreadable');
    expect(h.recordTerminalSkip).not.toHaveBeenCalled();
  });
});
