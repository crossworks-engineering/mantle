/**
 * The images backfill's door (`pictures_requested`,
 * extractPicturesOnRequest in ./images.ts): refused for what the extractor
 * refuses (an exempt node, one whose read took the process down, no
 * extractor worker), and a read that found every slot busy is asked again
 * later, a bounded number of times, instead of being dropped. The database,
 * the file bytes and the picture reader are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  node: null as Record<string, unknown> | null,
  worker: { id: 'w1', slug: 'extractor', params: {} } as unknown,
  extract: vi.fn(),
  loadFileBytes: vi.fn(),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  // A select of whole rows is the node; one of columns the dedupe (no
  // images yet).
  const select = vi.fn((columns?: unknown) => {
    const rows = columns === undefined ? (h.node ? [h.node] : []) : [];
    const chain = { from: () => chain, where: () => chain, limit: async () => rows };
    return chain;
  });
  return { ...actual, db: { ...actual.db, select } };
});
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return { ...actual, resolveEffectiveIndexing: async () => ({ effective: 'full' }) };
});
vi.mock('@mantle/files/embedded-images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files/embedded-images')>();
  return { ...actual, extractEmbeddedImages: h.extract };
});
vi.mock('./model', () => ({ resolveExtractor: async () => h.worker }));
vi.mock('./file-bytes', () => ({ loadFileBytes: h.loadFileBytes }));
vi.mock('./read-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./read-guard')>();
  return {
    ...actual,
    guardedReadFor: (_n: unknown, _e: string, _p: string, read: () => Promise<unknown>) => read(),
  };
});
vi.mock('./trace', () => ({ stepInOwnTrace: vi.fn() }));

import { DocumentReadRetryableError } from '@mantle/files';
import {
  PICTURES_REQUESTED_CHANNEL,
  PICTURES_RETRY_DELAYS_MS,
  extractPicturesOnRequest,
} from './images';

const written = new Date('2026-10-27T10:00:00.000Z');
function fileNode(data: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    ownerId: 'o1',
    type: 'file',
    title: 'manual.pdf',
    data: { filename: 'manual.pdf', ...data },
    updatedAt: written,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.node = fileNode();
  h.worker = { id: 'w1', slug: 'extractor', params: {} };
  h.extract.mockReset();
  h.loadFileBytes.mockResolvedValue({
    bytes: Buffer.from('%PDF'),
    ext: 'pdf',
    filename: 'manual.pdf',
    mime: 'application/pdf',
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('extractPicturesOnRequest', () => {
  it('listens on its own channel', () => {
    expect(PICTURES_REQUESTED_CHANNEL).toBe('pictures_requested');
  });

  it('takes the pictures of an ordinary file', async () => {
    h.extract.mockResolvedValue({ images: [], rejected: {}, candidates: 0 });
    await extractPicturesOnRequest('n1', 'o1');
    expect(h.extract).toHaveBeenCalledTimes(1);
  });

  it('refuses an exempt node, a crashed read and a brain with no extractor worker', async () => {
    h.node = fileNode({ source: 'forum-archive' });
    await extractPicturesOnRequest('n1', 'o1');
    h.node = fileNode({
      extract_skipped: {
        reason: 'document_too_large',
        at: written.toISOString(),
        reading: 'pictures',
      },
    });
    await extractPicturesOnRequest('n1', 'o1');
    h.node = fileNode();
    h.worker = null;
    await extractPicturesOnRequest('n1', 'o1');
    expect(h.extract).not.toHaveBeenCalled();
  });

  it('asks again when every read slot is busy, a bounded number of times', async () => {
    h.extract.mockRejectedValue(new DocumentReadRetryableError('busy'));
    await extractPicturesOnRequest('n1', 'o1');
    expect(h.extract).toHaveBeenCalledTimes(1);
    for (const [i, wait] of PICTURES_RETRY_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(wait);
      expect(h.extract).toHaveBeenCalledTimes(i + 2);
    }
    // Given up: no more tries however long it waits.
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000);
    expect(h.extract).toHaveBeenCalledTimes(PICTURES_RETRY_DELAYS_MS.length + 1);
  });
});
