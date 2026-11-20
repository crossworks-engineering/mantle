/**
 * GET and PATCH /api/embedding/extraction without a database: the body
 * takes `book_concurrency` beside `concurrency` (0393), each 1 to its max or
 * null; a save tells the agent at once. The real rows:
 * extraction-settings.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  notify: vi.fn(),
  counts: vi.fn(),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: () => ({ id: 'owner-id' }),
}));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readExtractionLaneSettings: h.read,
  saveExtractionLanePatch: h.save,
  clearEmbeddingModelCache: () => {},
}));
vi.mock('@/lib/extraction-queue', () => ({ extractionQueueCountsOrNull: h.counts }));
vi.mock('@/lib/embedding-config', () => ({ notifyProviderRecover: h.notify }));

import { GET, PATCH } from './route';

const SETTING = (saved: number | null, effective: number, max: number) => ({
  saved,
  effective,
  source: saved === null ? 'default' : 'saved',
  default: effective,
  min: 1,
  max,
});

const patch = (body: unknown) =>
  PATCH(
    new Request('http://local/api/embedding/extraction', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.read.mockResolvedValue({
    configured: true,
    concurrency: SETTING(null, 2, 16),
    book_concurrency: SETTING(2, 2, 4),
    time_budget_minutes: SETTING(null, 60, 720),
  });
  h.save.mockResolvedValue(true);
  h.counts.mockResolvedValue({ running: 0 });
});

describe('GET /api/embedding/extraction', () => {
  it('gives each lane setting with its source, and the queue', async () => {
    const body = await (await GET()).json();
    expect(body.book_concurrency).toMatchObject({
      saved: 2,
      effective: 2,
      source: 'saved',
      max: 4,
    });
    expect(body.concurrency).toMatchObject({ saved: null, effective: 2, source: 'default' });
    expect(body.time_budget_minutes).toMatchObject({ effective: 60 });
    expect(body.queue).toEqual({ running: 0 });
    expect(h.read).toHaveBeenCalledWith('owner-id');
  });
});

describe('PATCH /api/embedding/extraction', () => {
  it('saves books at once alone, and tells the agent', async () => {
    const res = await patch({ book_concurrency: 2 });
    expect(res.status).toBe(200);
    expect(h.save).toHaveBeenCalledWith('owner-id', {
      concurrency: undefined,
      bookConcurrency: 2,
    });
    expect(h.notify).toHaveBeenCalledWith('owner-id');
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, book_concurrency: { saved: 2 } });
    // The answer the settings screen reads stays: the count's saved and in use.
    expect(body).toMatchObject({ saved: null, effective: 2 });
  });

  it('saves the count alone as before, and null clears', async () => {
    expect((await patch({ concurrency: 4 })).status).toBe(200);
    expect(h.save).toHaveBeenLastCalledWith('owner-id', {
      concurrency: 4,
      bookConcurrency: undefined,
    });
    expect((await patch({ concurrency: null, book_concurrency: null })).status).toBe(200);
    expect(h.save).toHaveBeenLastCalledWith('owner-id', {
      concurrency: null,
      bookConcurrency: null,
    });
  });

  it('refuses a book count out of 1 to 4, a fraction, a string or an empty body', async () => {
    for (const body of [
      { book_concurrency: 5 },
      { book_concurrency: 0 },
      { book_concurrency: 1.5 },
      { book_concurrency: '2' },
      { concurrency: 17 },
      {},
      [],
    ]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.save).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('is a 409 before the embedder is set up', async () => {
    h.save.mockResolvedValue(false);
    const res = await patch({ book_concurrency: 2 });
    expect(res.status).toBe(409);
    expect(h.notify).not.toHaveBeenCalled();
  });
});
