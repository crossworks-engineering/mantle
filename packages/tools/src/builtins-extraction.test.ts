/**
 * extraction_get and extraction_set: the extractor's lane settings over MCP,
 * through the one reader and writer (@mantle/embeddings
 * extraction-settings.ts), stubbed here; the real rows and the narrow
 * login's refusal are extraction-settings.db.test.ts (server/web) and
 * narrow-rules-14.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
  counts: vi.fn(),
}));

vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readExtractionLaneSettings: h.read,
  saveExtractionLanePatch: h.save,
  clearEmbeddingModelCache: h.clear,
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  extractionQueueCounts: h.counts,
}));

import { EXTRACTION_TOOLS, extraction_get, extraction_set } from './builtins-extraction';

const ctx = { ownerId: 'owner-1' } as never;
const SETTING = (effective: number, max: number) => ({
  saved: null,
  effective,
  source: 'default',
  default: effective,
  min: 1,
  max,
});
const SETTINGS = {
  configured: true,
  concurrency: SETTING(2, 16),
  book_concurrency: SETTING(1, 4),
  time_budget_minutes: SETTING(60, 720),
};
const QUEUE = { running: 0, waiting: 0, retrying: 0, doneRecent: 0, deadLettered: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  h.read.mockResolvedValue(SETTINGS);
  h.save.mockResolvedValue(true);
  h.counts.mockResolvedValue(QUEUE);
});

describe('the extraction tools', () => {
  it('are MCP only, in the settings area, run whole', () => {
    expect(EXTRACTION_TOOLS.map((t) => t.slug)).toEqual(['extraction_get', 'extraction_set']);
    for (const t of EXTRACTION_TOOLS) {
      expect(t.mcpOnly).toBe(true);
      expect(t.policy?.scope).toEqual({ area: 'settings', systemWhole: true });
    }
    expect(extraction_get.policy?.effect).toBe('read');
    expect(extraction_set.policy?.effect).toBe('write');
  });
});

describe('extraction_get', () => {
  it('gives the settings and the queue counts, for the caller`s owner', async () => {
    const r = await extraction_get.handler({}, ctx);
    expect(r).toEqual({ ok: true, output: { ...SETTINGS, queue: QUEUE } });
    expect(h.read).toHaveBeenCalledWith('owner-1');
  });

  it('says a failed read as a tool error', async () => {
    h.read.mockRejectedValue(new Error('db down'));
    const r = await extraction_get.handler({}, ctx);
    expect(r.ok).toBe(false);
  });
});

describe('extraction_set', () => {
  it('saves only what it is given: a number sets, null clears, absent leaves', async () => {
    const r = await extraction_set.handler({ book_concurrency: 3, time_budget_minutes: null }, ctx);
    expect(h.save).toHaveBeenCalledWith('owner-1', {
      concurrency: undefined,
      bookConcurrency: 3,
      timeBudgetMinutes: null,
    });
    expect(h.clear).toHaveBeenCalledWith('owner-1');
    expect(r).toMatchObject({ ok: true, output: { ...SETTINGS } });
  });

  it('refuses a value out of range, a string and an empty call, and saves nothing', async () => {
    for (const input of [
      { book_concurrency: 5 },
      { book_concurrency: 0 },
      { concurrency: 17 },
      { time_budget_minutes: 721 },
      { concurrency: '2' },
      { book_concurrency: 1.5 },
      {},
    ]) {
      const r = await extraction_set.handler(input, ctx);
      expect(r.ok, JSON.stringify(input)).toBe(false);
    }
    expect(h.save).not.toHaveBeenCalled();
  });

  it('names the setting and its range in the refusal', async () => {
    expect(await extraction_set.handler({ book_concurrency: 9 }, ctx)).toEqual({
      ok: false,
      error: 'book_concurrency must be a whole number 1 to 4, or null',
    });
  });

  it('says so when the brain has no embedder row yet', async () => {
    h.save.mockResolvedValue(false);
    const r = await extraction_set.handler({ book_concurrency: 2 }, ctx);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Set up the embedder/) });
    expect(h.clear).not.toHaveBeenCalled();
  });
});
