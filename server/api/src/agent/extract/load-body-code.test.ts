/**
 * The file types the fleet sweep of 2026-11-25 found kept by name only, read
 * now (packages/files slug.ts): code, config and logs as text (CODE_EXTS,
 * the `utf8` route) with their chunks; a binary under a code name as the
 * reader's verdict (document_unreadable), never as garbage; a .jfif through
 * the vision read like a .jpg; a Word backup (.wbk) through anydoc.
 *
 * The node loader, file bytes, tracing, the vision/OCR passes and the stamp
 * are stubbed, as in load-body-terminal.test.ts; the branching is real, and
 * so is the text read of a code file (no parser is asked for it).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkDocText } from '@mantle/content';

const h = vi.hoisted(() => ({
  recordSkippedTrace: vi.fn(),
  recordTerminalSkip: vi.fn(),
  ocrIngestPdfNode: vi.fn(),
  visionIngestImageNode: vi.fn(),
  loadFileBytes: vi.fn(),
  tryUnlockPdf: vi.fn(),
  documentWorkerPrefersNative: vi.fn(),
  parseDocumentBytes: vi.fn(),
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
// The parser's reads: the real one unless a test sets its own answer.
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  h.parseDocumentBytes.mockImplementation(actual.parseDocumentBytes);
  return { ...actual, parseDocumentBytes: h.parseDocumentBytes };
});
vi.mock('./file-bytes', () => ({ loadFileBytes: h.loadFileBytes, tryUnlockPdf: h.tryUnlockPdf }));
vi.mock('./images', () => ({
  ocrIngestPdfNode: h.ocrIngestPdfNode,
  nativeReadPdfNode: vi.fn(async () => ({ text: null })),
  visionIngestImageNode: h.visionIngestImageNode,
  composeImageBody: vi.fn((_d: unknown, text: string) => text),
}));
vi.mock('./terminal', () => ({ recordTerminalSkip: h.recordTerminalSkip }));
// No Reader of the box takes these files (a .png has none): the registry (a
// database read) is not asked.
vi.mock('@mantle/content/reader-passes', () => ({
  readerPassOf: vi.fn(async () => null),
  readerTextOf: vi.fn(async () => ''),
  standingReaderText: vi.fn(async () => null),
}));

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

/** Disposition of the terminal skip recorded. */
const terminal = () =>
  (h.recordTerminalSkip.mock.calls[0]?.[0] as { disposition?: string } | undefined)?.disposition;

beforeEach(() => {
  vi.clearAllMocks();
  h.recordSkippedTrace.mockResolvedValue(undefined);
  h.recordTerminalSkip.mockResolvedValue(undefined);
  h.loadFileBytes.mockResolvedValue(null);
  h.tryUnlockPdf.mockResolvedValue(null);
  h.documentWorkerPrefersNative.mockResolvedValue(false);
});

const PY_LINES = [
  '"""Made-up pump checks."""',
  ...Array.from(
    { length: 200 },
    (_, i) => `def check_p${100 + i}(bar):  # seal of pump P-${100 + i}\n    return bar <= 16`,
  ),
];
const PY = PY_LINES.join('\n');

const bytesOf = (filename: string, ext: string, bytes: Buffer) => ({
  bytes,
  filename,
  ext,
  mime: 'application/octet-stream',
});

describe('loadExtractableBody: code, jfif and wbk', () => {
  it('a .py file is read as its text, and chunks into real passages', async () => {
    h.loadFileBytes.mockResolvedValue(bytesOf('pump_checks.py', 'py', Buffer.from(PY)));
    const res = await run(fileNode('pump_checks.py', 'application/octet-stream'));
    expect(res.ok).toBe(true);
    const body = res.ok ? res.rawBody : '';
    expect(body).toContain('def check_p150(bar):');
    expect(body).not.toContain('File type:');
    expect(h.parseDocumentBytes).toHaveBeenCalledWith(expect.any(Buffer), 'py', undefined);
    const chunks = chunkDocText(body);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((c) => c.text.includes('seal of pump P-299'))).toBe(true);
    expect(h.recordTerminalSkip).not.toHaveBeenCalled();
    expect(h.visionIngestImageNode).not.toHaveBeenCalled();
  });

  it('a binary under a code name is document_unreadable, not text', async () => {
    const elf = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]),
      Buffer.alloc(64),
    ]);
    h.loadFileBytes.mockResolvedValue(bytesOf('tool.ts', 'ts', elf));
    const res = await run(fileNode('tool.ts', 'application/octet-stream'));
    expect(res.ok).toBe(false);
    expect(terminal()).toBe('document_unreadable');
    const details = (
      h.recordTerminalSkip.mock.calls[0]?.[0] as { details: Record<string, unknown> }
    ).details;
    expect(details.parser_code).toBe('unsupported');
    expect(String(details.hint)).toMatch(/named \.ts but its bytes are not text/);
  });

  it('a .jfif goes to the vision read, as a .jpg does, even with octet-stream stored', async () => {
    h.visionIngestImageNode.mockResolvedValue({
      text: 'A pump skid with two motors.',
      failure: null,
      ran: true,
    });
    const res = await run(fileNode('skid.jfif', 'application/octet-stream'));
    expect(h.visionIngestImageNode).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(h.parseDocumentBytes).not.toHaveBeenCalled();
  });

  it('a .wbk goes to the document read (anydoc in the parser)', async () => {
    h.loadFileBytes.mockResolvedValue(bytesOf('backup-of-report.wbk', 'wbk', Buffer.alloc(512, 1)));
    h.parseDocumentBytes.mockResolvedValueOnce(
      'Pump P-101 seal replaced. Second line of the backup.',
    );
    const res = await run(fileNode('backup-of-report.wbk', 'application/msword'));
    expect(h.parseDocumentBytes).toHaveBeenCalledWith(expect.any(Buffer), 'wbk', undefined);
    expect(res.ok && res.rawBody).toContain('Pump P-101 seal replaced.');
    expect(h.visionIngestImageNode).not.toHaveBeenCalled();
  });
});
