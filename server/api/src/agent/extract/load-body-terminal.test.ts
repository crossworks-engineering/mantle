/**
 * Which body dead-ends are TERMINAL (stamped `data.extract_skipped`, so the
 * boot drain and the provider recovery drain stop re-queuing the node) and
 * which are left for the drain to retry.
 *
 * One box, 2026-10-04: an .exe file (`no_parser`) had 16 extract jobs in 3
 * days, re-queued by every restart and every provider recovery, because a
 * skip left no mark the drain could see. (Since the default text, a type no
 * reader takes is indexed by its name, type and size, and is no skip.) A content verdict is terminal; a
 * worker that did not run is not, or a provider outage would lock an image
 * out of the brain for good.
 *
 * The node loader, file bytes, tracing, the vision/OCR passes and the stamp
 * are stubbed; the branching under test is real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderWaitError } from '@mantle/std';

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

import { defaultFileText, isDefaultFileText, ParserError } from '@mantle/files';
import { loadExtractableBody, readNodeBodyLocal } from './load-body';

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
  it('a file no reader takes (an .exe) gets the default text, and no skip', async () => {
    h.loadFileBytes.mockResolvedValue({
      bytes: Buffer.alloc(3000, 1),
      filename: 'setup-tool-installer-v2.exe',
      ext: 'exe',
      mime: 'application/octet-stream',
    });
    const res = await run(fileNode('setup-tool-installer-v2.exe', 'application/octet-stream'));
    expect(res.ok && res.rawBody).toContain('File name: setup-tool-installer-v2.exe');
    expect(res.ok && res.rawBody).toContain('File type: .exe');
    expect(res.ok && res.rawBody).toContain('File size: 2.9 KB (3000 bytes)');
    expect(h.recordTerminalSkip).not.toHaveBeenCalled();
    expect(h.recordSkippedTrace).not.toHaveBeenCalled();
    // No model is asked for the text: no vision worker, no OCR worker.
    expect(h.visionIngestImageNode).not.toHaveBeenCalled();
    expect(h.ocrIngestPdfNode).not.toHaveBeenCalled();
  });

  it('the default text also when the file has no bytes to read', async () => {
    const res = await run(fileNode('archive-of-site-photos.7z', 'application/x-7z-compressed'));
    expect(res.ok && res.rawBody).toContain('File name: archive-of-site-photos.7z');
    expect(res.ok && res.rawBody).not.toContain('File size');
    expect(h.recordTerminalSkip).not.toHaveBeenCalled();
  });

  it('a stored default text is made again, never read as the body', async () => {
    const first = await run(fileNode('notes-from-the-field.lx9', 'application/octet-stream'));
    expect(first.ok).toBe(true);
    const stored = first.ok ? first.rawBody : '';
    h.loadFileBytes.mockResolvedValue({
      bytes: Buffer.alloc(10),
      filename: 'notes-from-the-field.lx9',
      ext: 'lx9',
      mime: 'application/octet-stream',
    });
    const again = await run(
      fileNode('notes-from-the-field.lx9', 'application/octet-stream', { text: stored }),
    );
    expect(again.ok && again.rawBody).toContain('File size: 10 bytes');
  });

  it('a stored default text does not stand in for the OCR of a file renamed to .pdf', async () => {
    // Indexed as report.bin, then renamed: the row still has the default text.
    const stored = await defaultFileText({
      filename: 'scanned-report.bin',
      ext: 'bin',
      bytes: Buffer.alloc(64, 1),
    });
    h.ocrIngestPdfNode.mockResolvedValue({
      text: 'The quick brown fox jumps over the lazy dog.',
      encrypted: false,
      bytesMissing: false,
      rasterizeError: null,
      ran: true,
    });
    const res = await run(fileNode('scanned-report.pdf', 'application/pdf', { text: stored }));
    expect(h.ocrIngestPdfNode).toHaveBeenCalled();
    expect(res.ok && res.rawBody).toContain('The quick brown fox');
    expect(res.ok && res.rawBody).not.toContain('File name:');
  });

  describe('one type, one read: the cost guard local read gives the same default text', () => {
    // Repsol, 2026-11-13: 152 files of one type with no reader, one upload,
    // one folder. The first 72 were read before the folder had an assistant
    // (the cost guard's local read: their name as the document), the other
    // 80 after (the full pass: a skip). The local read now gives the
    // default text as the full pass does.
    const bytes = Buffer.concat([
      Buffer.from([0x44, 0x33, 0x22, 0x11, 0x53, 0x55, 0x52, 0x44]),
      Buffer.alloc(56),
    ]);
    const load = () =>
      h.loadFileBytes.mockResolvedValue({
        bytes,
        filename: 'weld-scan-0042.opd',
        ext: 'opd',
        mime: 'application/octet-stream',
      });

    it('the local read and the full pass give one text', async () => {
      load();
      const node = fileNode('weld-scan-0042.opd', 'application/octet-stream');
      const local = await readNodeBodyLocal(node);
      const full = await run(node);
      expect(local).toContain('File name: weld-scan-0042.opd');
      expect(local).toContain('File type: .opd');
      expect(local).toContain('File size: 64 bytes');
      expect(isDefaultFileText(local)).toBe(true);
      expect(full.ok && full.rawBody).toBe(local);
      expect(h.recordTerminalSkip).not.toHaveBeenCalled();
    });

    it('the local read makes a stored default text again, as the full pass does', async () => {
      const stored = await defaultFileText({
        filename: 'weld-scan-0042.opd',
        ext: 'opd',
        bytes: null,
      });
      load();
      const local = await readNodeBodyLocal(
        fileNode('weld-scan-0042.opd', 'application/octet-stream', { text: stored }),
      );
      expect(local).toContain('File size: 64 bytes');
    });

    it('a type WITH a reader keeps its own local read (the name, never a default text)', async () => {
      const local = await readNodeBodyLocal(fileNode('renamed-office-file.dwg', 'image/vnd.dwg'));
      expect(local).toBe('renamed-office-file.dwg');
    });
  });

  it('a note whose own words look like a default text keeps them as its body', async () => {
    const content = await defaultFileText({ filename: 'listing.lx9', ext: 'lx9', bytes: null });
    const res = await run({
      ...fileNode('x', 'text/plain'),
      type: 'note',
      title: 'Listing',
      data: { content },
    } as never);
    expect(res.ok).toBe(true);
    expect(res.ok && res.rawBody).toContain('File name:');
  });

  it('a type WITH a reader whose bytes are not that type keeps the no_parser skip', async () => {
    const res = await run(fileNode('renamed-office-file.dwg', 'image/vnd.dwg'));
    expect(res.ok).toBe(false);
    expect(terminal()).toBe('no_parser');
    expect(h.recordSkippedTrace).not.toHaveBeenCalled();
  });

  describe('a reader fails on bytes of its format', () => {
    const dwg = () => {
      h.loadFileBytes.mockResolvedValue({
        bytes: Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(200)]),
        filename: 'site-layout.dwg',
        ext: 'dwg',
        mime: 'image/vnd.dwg',
      });
      return fileNode('site-layout.dwg', 'image/vnd.dwg');
    };

    it('records document_unreadable with the code, never a renamed file', async () => {
      h.parseDocumentBytes.mockRejectedValueOnce(
        new ParserError('failed', 'ezdwg could not convert the drawing', {
          retryable: false,
          terminal: false,
        }),
      );
      const res = await run(dwg());
      expect(res.ok).toBe(false);
      expect(terminal()).toBe('document_unreadable');
      const details = (
        h.recordTerminalSkip.mock.calls[0]?.[0] as { details: Record<string, unknown> }
      ).details;
      expect(details.parser_code).toBe('failed');
      expect(details.hint).toContain('The reader could not read the document.');
      expect(details.hint).not.toContain('twice');
    });

    it('a busy parser still retries the extract', async () => {
      const busy = new ParserError('busy', 'busy', { retryable: true, terminal: false });
      h.parseDocumentBytes.mockRejectedValueOnce(busy);
      await expect(run(dwg())).rejects.toBe(busy);
      expect(h.recordTerminalSkip).not.toHaveBeenCalled();
    });

    it('a corrupt .docx is document_unreadable, not indexed as its own name', async () => {
      h.loadFileBytes.mockResolvedValue({
        bytes: Buffer.from('PK made up'),
        filename: 'site-inspection-report.docx',
        ext: 'docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      h.parseDocumentBytes.mockRejectedValueOnce(
        new ParserError('failed', 'the document is damaged', { retryable: false, terminal: false }),
      );
      const res = await run(
        fileNode(
          'site-inspection-report.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      );
      expect(res.ok).toBe(false);
      expect(terminal()).toBe('document_unreadable');
    });

    it.each([
      ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['vsdx', 'application/vnd.ms-visio.drawing'],
      ['odt', 'application/vnd.oasis.opendocument.text'],
      ['html', 'text/html'],
      ['dwf', 'model/vnd.dwf'],
    ])('a reader verdict on a .%s is document_unreadable', async (ext, mime) => {
      const filename = `quarterly-site-record.${ext}`;
      h.loadFileBytes.mockResolvedValue({ bytes: Buffer.from('made up'), filename, ext, mime });
      h.parseDocumentBytes.mockRejectedValueOnce(
        new ParserError('unsupported', 'not readable', { retryable: false, terminal: false }),
      );
      const res = await run(fileNode(filename, mime));
      expect(res.ok).toBe(false);
      expect(terminal()).toBe('document_unreadable');
    });

    it("an own Reader's verdict is document_unreadable too, not the default text", async () => {
      const { readerPassOf } = await import('@mantle/content/reader-passes');
      vi.mocked(readerPassOf).mockResolvedValueOnce((async () => ({ status: 'ok' })) as never);
      h.loadFileBytes.mockResolvedValue({
        bytes: Buffer.from('ISO-10303-21; made up'),
        filename: 'plant-model.ifc',
        ext: 'ifc',
        mime: 'application/octet-stream',
      });
      h.parseDocumentBytes.mockRejectedValueOnce(
        new ParserError('failed', 'the step failed', { retryable: false, terminal: false }),
      );
      const res = await run(fileNode('plant-model.ifc', 'application/octet-stream'));
      expect(res.ok).toBe(false);
      expect(terminal()).toBe('document_unreadable');
    });

    it('a PDF reader verdict keeps its own recovery path (OCR from the title)', async () => {
      h.loadFileBytes.mockResolvedValue({
        bytes: Buffer.from('%PDF-1.7 made up'),
        filename: 'statement.pdf',
        ext: 'pdf',
        mime: 'application/pdf',
      });
      h.parseDocumentBytes.mockRejectedValueOnce(
        new ParserError('failed', 'a password is needed', { retryable: false, terminal: false }),
      );
      h.ocrIngestPdfNode.mockResolvedValue({
        text: null,
        encrypted: true,
        bytesMissing: false,
        rasterizeError: null,
        ran: true,
      });
      await run(fileNode('statement.pdf', 'application/pdf'));
      expect(h.ocrIngestPdfNode).toHaveBeenCalled();
      expect(terminal()).not.toBe('document_unreadable');
    });
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

  it('the provider says "not now" to an image: the read waits in the queue, no skip at all', async () => {
    h.visionIngestImageNode.mockResolvedValue({
      text: null,
      failure: 'Vision worker failed: 429',
      ran: false,
      wait: { reason: 'rate_limit', status: 429 },
    });
    const err = await run(fileNode('plan.png', 'image/png')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderWaitError);
    expect((err as ProviderWaitError).wait.reason).toBe('rate_limit');
    expect(h.recordSkippedTrace).not.toHaveBeenCalled();
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
