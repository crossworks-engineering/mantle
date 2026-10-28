/**
 * The author's summary at an app's publish (Journal v3 J9): a free write,
 * never a model call (the generated one is the extract job's). Pinned: no
 * text is no summary and no read; a new text is the author's summary; the
 * same text again is no write; a failed read is null, never a throw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows: unknown[][] = [];
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rows.shift() ?? [],
  };
  return { ...actual, db: { select: () => chain } };
});
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, getApp: vi.fn() };
});

import { appSummaryHash, getApp } from '@mantle/content';
import { appAuthorSummary } from './publish-summary';

const KEY = 'published' + '_summary';
const ID = '11111111-2222-4333-8444-555555555555';
const source = { entry: 'App.tsx', files: { 'App.tsx': 'export default () => null;' } };
const manifest = { description: 'Pump log' };

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  vi.mocked(getApp).mockResolvedValue({ id: ID, source, draft: null, manifest } as never);
});

describe('appAuthorSummary', () => {
  it('is null for no text, reading nothing', async () => {
    expect(await appAuthorSummary('o1', ID)).toBeNull();
    expect(await appAuthorSummary('o1', ID, '  ')).toBeNull();
    expect(getApp).not.toHaveBeenCalled();
  });

  it("is the author's summary of the code being published", async () => {
    rows.push([{ data: {} }]);
    expect(await appAuthorSummary('o1', ID, ' Logs pumps. ')).toMatchObject({
      text: 'Logs pumps.',
      source: 'author',
      model: null,
      hash: appSummaryHash(source, manifest as never),
    });
  });

  it('is null for the same text kept already', async () => {
    rows.push([{ data: { [KEY]: { text: 'Logs pumps.', source: 'author', hash: 'h' } } }]);
    expect(await appAuthorSummary('o1', ID, 'Logs pumps.')).toBeNull();
  });

  it('is null, never a throw, when the app cannot be read', async () => {
    vi.mocked(getApp).mockRejectedValue(new Error('db down'));
    expect(await appAuthorSummary('o1', ID, 'Mine.')).toBeNull();
  });
});
