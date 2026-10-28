// POST /api/apps/:id/publish with only a summary (Journal v3 J9, fix L2):
// with no draft the author's summary is written alone (setAppAuthorSummary)
// and a staged rebuild is never promoted; with a draft it is the usual
// build and publish, with the summary. The summary is appAuthorSummary's,
// the helper app_publish uses. The content layer and the auth gate are
// stand-ins; setAppAuthorSummary itself runs on Postgres in
// packages/content/src/app-snapshots.db.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const APP = '77777777-7777-4777-8777-777777777777';
const SUMMARY = {
  text: 'Logs readings.',
  source: 'author' as const,
  hash: 'h',
  at: '2026-10-28T00:00:00.000Z',
  model: null,
};

const h = vi.hoisted(() => ({
  existing: null as null | { id: string; draft: unknown; draftBuild?: unknown },
  getApp: vi.fn(),
  publishApp: vi.fn(),
  setAppAuthorSummary: vi.fn(),
  appAuthorSummary: vi.fn(),
  buildAndStageApp: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ ownerCaller: () => ({ id: 'o1' }) }));
vi.mock('@/lib/read-body', () => ({ readBody: async (req: Request) => req.json() }));
vi.mock('@mantle/db', () => ({
  assertItemRight: vi.fn(async () => undefined),
  PUBLISHED_SUMMARY_MAX_CHARS: 600,
}));
vi.mock('@mantle/content', () => ({
  getApp: h.getApp,
  publishApp: h.publishApp,
  setAppAuthorSummary: h.setAppAuthorSummary,
}));
vi.mock('@mantle/tools', () => ({
  appAuthorSummary: h.appAuthorSummary,
  buildAndStageApp: h.buildAndStageApp,
}));

import { POST } from './route';

const post = (body: unknown) =>
  POST(
    new Request(`https://brain.example.com/api/apps/${APP}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: APP }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.getApp.mockImplementation(async () => h.existing);
  h.appAuthorSummary.mockImplementation(async (_o: string, _id: string, given?: string) =>
    given ? SUMMARY : null,
  );
  h.setAppAuthorSummary.mockResolvedValue({ id: APP, summarised: true });
  h.publishApp.mockResolvedValue({ id: APP, published: true });
  h.buildAndStageApp.mockResolvedValue({ buildOk: true, errors: [], warnings: [] });
});

describe('POST /api/apps/:id/publish, a summary with no draft', () => {
  it('writes the summary alone and never promotes a staged rebuild', async () => {
    h.existing = { id: APP, draft: null, draftBuild: { ok: true, storageKey: 'staged' } };
    const res = await post({ summary: 'Logs readings.' });
    expect(res.status).toBe(200);
    expect(h.appAuthorSummary).toHaveBeenCalledWith('o1', APP, 'Logs readings.');
    expect(h.setAppAuthorSummary).toHaveBeenCalledWith('o1', APP, SUMMARY);
    expect(h.publishApp).not.toHaveBeenCalled();
    expect(h.buildAndStageApp).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ app: { id: APP, summarised: true } });
  });

  it('with no summary either: a no-op, nothing written', async () => {
    h.existing = { id: APP, draft: null, draftBuild: { ok: true, storageKey: 'staged' } };
    const res = await post({});
    expect(await res.json()).toEqual({ app: h.existing });
    expect(h.setAppAuthorSummary).not.toHaveBeenCalled();
    expect(h.publishApp).not.toHaveBeenCalled();
  });

  it('with a draft: built and published, with the summary', async () => {
    h.existing = { id: APP, draft: { entry: 'App.tsx', files: {} } };
    await post({ summary: 'Logs readings.' });
    expect(h.buildAndStageApp).toHaveBeenCalledWith('o1', APP);
    expect(h.publishApp).toHaveBeenCalledWith('o1', APP, { summary: SUMMARY });
    expect(h.setAppAuthorSummary).not.toHaveBeenCalled();
  });
});
