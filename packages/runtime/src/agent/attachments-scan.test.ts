/**
 * A scanned PDF attached in chat (extractAttachmentForTurn): the Scan
 * reader reads it page by page for the turn (readScannedPdf), no native
 * read and no vision OCR, every page in the turn's time; what is not read,
 * and why, is said in the note, never cut in silence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParserError } from '@mantle/files';
import type { ScanPage } from './scan-pdf';

const h = vi.hoisted(() => ({
  readScannedPdf: vi.fn(),
  scanFinalReadOf: vi.fn(),
  setChatReading: vi.fn(),
  hooks: { claim: vi.fn(), keep: vi.fn(), wait: vi.fn() },
}));

vi.mock('@mantle/db', () => ({
  bumpWorkerUsage: vi.fn(),
  getDefaultWorker: vi.fn(async () => null),
}));
vi.mock('@mantle/api-keys', () => ({
  getApiKeyById: vi.fn(async () => null),
  resolveDefaultWorker: vi.fn(async () => ({ ok: false, why: 'none', worker: null })),
}));
vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof import('@mantle/files')>()),
  parseDocumentBytes: vi.fn(async () => ''),
}));
vi.mock('./scan-pdf', async (orig) => ({
  ...(await orig<typeof import('./scan-pdf')>()),
  readScannedPdf: h.readScannedPdf,
}));

vi.mock('./scan-share', () => ({
  scanFinalReadOf: h.scanFinalReadOf,
  setChatReading: h.setChatReading,
  scanShareHooks: vi.fn(() => h.hooks),
}));

import { extractAttachmentForTurn, TURN_SCAN_MS } from './attachments';

const page = (n: number, method: ScanPage['method'], text = '', why?: ScanPage['why']) =>
  ({ page: n, method, text, ...(why ? { why } : {}) }) as ScanPage;

const send = (fileId: string | null = 'f1') =>
  extractAttachmentForTurn({
    ownerId: 'o1',
    bytes: Buffer.from('%PDF-1.4 scan'),
    mimeType: 'application/pdf',
    filename: 'invoice.pdf',
    fileId,
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.scanFinalReadOf.mockResolvedValue(null);
  h.setChatReading.mockResolvedValue(undefined);
});

describe('a scanned PDF in chat', () => {
  it('is read whole by the Scan reader, in the turn’s time', async () => {
    h.readScannedPdf.mockResolvedValue({
      pages: [page(1, 'scan_reader', 'Invoice 42'), page(2, 'blank')],
      pagesTotal: 2,
      ran: true,
      model: 'm',
    });
    const before = Date.now();
    const out = await send();
    expect(out.text).toBe('[Page 1]\nInvoice 42');
    expect(out.note).toBe('Scanned PDF of 2 pages: 2 read by the Scan reader.');
    const { deadline } = h.readScannedPdf.mock.calls[0]![0] as { deadline: number };
    expect(deadline).toBeGreaterThanOrEqual(before + TURN_SCAN_MS);
  });

  it('says the pages a long PDF left unread, and that the saved file is read whole', async () => {
    const pages = [
      page(1, 'scan_reader', 'one'),
      page(2, 'unread', '', 'bad_read'),
      ...Array.from({ length: 98 }, (_, i) => page(i + 3, 'unread', '', 'time')),
    ];
    h.readScannedPdf.mockResolvedValue({ pages, pagesTotal: 100, ran: true, model: 'm' });
    const out = await send();
    expect(out.note).toContain('Scanned PDF of 100 pages: 1 read by the Scan reader');
    expect(out.note).toContain('1 read badly by the Scan reader');
    expect(out.note).toContain('98 not reached in the time of this answer');
    expect(out.note).toContain('read whole in the background');
  });

  it('keeps what was read when the parser stops mid-file, and says so', async () => {
    h.readScannedPdf.mockImplementation(
      async (o: { onWindow: (p: ScanPage[], t: number) => Promise<void> }) => {
        await o.onWindow([page(1, 'scan_reader', 'first window')], 40);
        throw new ParserError('busy', 'busy', { retryable: true, terminal: false });
      },
    );
    const out = await send(null);
    expect(out.text).toBe('[Page 1]\nfirst window');
    expect(out.note).toContain('39 pages not read: the document reader is busy');
    expect(out.note).not.toContain('background');
  });

  it('says no page was read when none could be', async () => {
    h.readScannedPdf.mockResolvedValue({
      pages: [page(1, 'unread', '', 'no_scan_reader')],
      pagesTotal: 1,
      ran: false,
      model: null,
    });
    const out = await send();
    expect(out.text).toBe('');
    expect(out.note).toContain('this brain has no Scan reader');
  });

  it('shares its reads with the background read of the saved file', async () => {
    h.readScannedPdf.mockResolvedValue({
      pages: [page(1, 'scan_reader', 'one')],
      pagesTotal: 1,
      ran: true,
      model: 'm',
    });
    await send('f1');
    expect(h.readScannedPdf.mock.calls[0]![0]).toHaveProperty('share');
    // It says it reads, then that it ended.
    expect(h.setChatReading.mock.calls.map((c) => c[2] === null)).toEqual([false, true]);
    // No saved file: nothing to share with.
    vi.clearAllMocks();
    h.readScannedPdf.mockResolvedValue({ pages: [], pagesTotal: 0, ran: false, model: null });
    await send(null);
    expect(h.readScannedPdf.mock.calls[0]![0]).not.toHaveProperty('share');
    expect(h.setChatReading).not.toHaveBeenCalled();
  });

  it('takes a whole read the background read already made, with no call', async () => {
    h.scanFinalReadOf.mockResolvedValue({
      text: '[Page 1]\nRead in the background',
      ocr: { pages_read: 1, pages_total: 2, unread: { bad_read: 1 } },
    });
    const out = await send('f1');
    expect(h.readScannedPdf).not.toHaveBeenCalled();
    expect(out.text).toBe('[Page 1]\nRead in the background');
    expect(out.note).toContain('1 of 2 pages were read (1 read badly by the Scan reader');
  });

  it('takes the background read when it ended while the turn read', async () => {
    h.readScannedPdf.mockResolvedValue({
      pages: [],
      pagesTotal: 2,
      ran: false,
      model: null,
      readBefore: true,
    });
    h.scanFinalReadOf
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ text: 'All of it', ocr: true });
    const out = await send('f1');
    expect(out.text).toBe('All of it');
  });
});
