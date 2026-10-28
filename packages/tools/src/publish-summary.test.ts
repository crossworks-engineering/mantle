/**
 * Publish-time summaries (Journal v3 J9): when the summarizer is called and
 * with what. No live model: the chat adapter is a stub. Pinned:
 *
 *  - an author's summary costs nothing (no call);
 *  - an unchanged app (same code and manifest) costs nothing;
 *  - a publish that will be refused (no green build) costs nothing;
 *  - an item no assistant reads costs nothing (the extractor's cost guard);
 *  - otherwise ONE call, on the summarizer worker's model, with a capped
 *    input; a failed call is null, never retried;
 *  - a canvas sends its text and its picture in the one call.
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
  return {
    ...actual,
    db: { select: () => chain },
    llmWorkAllowed: vi.fn(async () => true),
    bumpWorkerUsage: vi.fn(async () => undefined),
  };
});
vi.mock('@mantle/api-keys', () => ({ resolveDefaultWorker: vi.fn() }));
vi.mock('@mantle/voice', () => ({ getChatAdapter: vi.fn() }));
vi.mock('@mantle/tracing', () => ({
  startTrace: vi.fn(async (_init: unknown, fn: () => unknown) => fn()),
  step: vi.fn(async (_init: unknown, fn: (h: unknown) => unknown) =>
    fn({ setOutput: () => {}, setMeta: () => {} }),
  ),
}));
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, getApp: vi.fn() };
});
vi.mock('@mantle/content/presents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/presents')>();
  return { ...actual, getPresent: vi.fn() };
});
vi.mock('./builtins-presents', () => ({ latestCanvasPicture: vi.fn(async () => null) }));

import { llmWorkAllowed } from '@mantle/db';
import { resolveDefaultWorker } from '@mantle/api-keys';
import { getChatAdapter } from '@mantle/voice';
import { appSummaryHash, getApp } from '@mantle/content';
import { getPresent, presentSummaryHash } from '@mantle/content/presents';
import { latestCanvasPicture } from './builtins-presents';
import {
  PUBLISH_SUMMARY_INPUT_MAX_CHARS,
  appPublishSummary,
  buildPublishSummaryMessages,
  presentPublishSummary,
} from './publish-summary';

const KEY = 'published' + '_summary';
const ID = '11111111-2222-4333-8444-555555555555';
const chat = vi.fn();

const source = { entry: 'App.tsx', files: { 'App.tsx': 'export default () => null;' } };
const manifest = {
  description: 'Pump log',
  sqlite: { schemaSql: 'CREATE TABLE readings (pump TEXT, mm REAL);', schemaVersion: 1 },
};
function app(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    title: 'Pumps',
    source,
    draft: null,
    manifest,
    draftBuild: { ok: true },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  vi.mocked(llmWorkAllowed).mockResolvedValue(true);
  vi.mocked(resolveDefaultWorker).mockResolvedValue({
    ok: true,
    worker: { id: 'w1', slug: 'summarizer', provider: 'openrouter', model: 'cheap-model' },
    credential: { apiKey: 'not-a-real-key' },
  } as never);
  vi.mocked(getChatAdapter).mockReturnValue({ chat } as never);
  chat.mockResolvedValue({ text: 'Logs pump readings for the crew. Table: readings.' });
  vi.mocked(getApp).mockResolvedValue(app() as never);
});

describe('appPublishSummary', () => {
  it("takes the author's summary and calls nothing", async () => {
    const s = await appPublishSummary('o1', ID, 'Logs pumps.');
    expect(s).toMatchObject({ text: 'Logs pumps.', source: 'author', model: null });
    expect(chat).not.toHaveBeenCalled();
  });

  it('makes one call on the summarizer worker when there is none', async () => {
    rows.push([{ data: {} }]);
    const s = await appPublishSummary('o1', ID);
    expect(chat).toHaveBeenCalledTimes(1);
    const req = chat.mock.calls[0]![0];
    expect(req.model).toBe('cheap-model');
    expect(req.messages[1].content).toContain('CREATE TABLE readings');
    expect(s).toMatchObject({
      source: 'publish',
      model: 'cheap-model',
      hash: appSummaryHash(source, manifest as never),
    });
  });

  it('calls nothing when the code and manifest are the ones the kept summary was made from', async () => {
    rows.push([
      {
        data: {
          [KEY]: {
            text: 'Old.',
            source: 'publish',
            hash: appSummaryHash(source, manifest as never),
            at: 'x',
            model: 'm',
          },
        },
      },
    ]);
    expect(await appPublishSummary('o1', ID)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it("never generates over an author's summary", async () => {
    rows.push([{ data: { [KEY]: { text: 'Mine.', source: 'author', hash: 'old' } } }]);
    expect(await appPublishSummary('o1', ID)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it('spends nothing on a publish that will be refused (no green build)', async () => {
    vi.mocked(getApp).mockResolvedValue(app({ draftBuild: null }) as never);
    rows.push([{ data: {} }]);
    expect(await appPublishSummary('o1', ID)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it('spends nothing on an item no assistant reads', async () => {
    vi.mocked(llmWorkAllowed).mockResolvedValue(false);
    rows.push([{ data: {} }]);
    expect(await appPublishSummary('o1', ID)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it('is null after a failed call, which is not tried again', async () => {
    chat.mockRejectedValue(new Error('provider down'));
    rows.push([{ data: {} }]);
    expect(await appPublishSummary('o1', ID)).toBeNull();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('is null, never a throw, when the app cannot be read', async () => {
    vi.mocked(getApp).mockRejectedValue(new Error('db down'));
    expect(await appPublishSummary('o1', ID, 'Mine.')).toBeNull();
  });
});

describe('presentPublishSummary', () => {
  const canvas = {
    id: ID,
    title: 'Feed pump P&ID',
    description: null,
    source: '<!doctype html><svg></svg>',
    meta: {},
    rev: 3,
  };

  it('sends the text and the picture in one call', async () => {
    vi.mocked(getPresent).mockResolvedValue(canvas as never);
    vi.mocked(latestCanvasPicture).mockResolvedValue({
      png: Buffer.from('png-bytes'),
      mime: 'image/png',
    });
    rows.push([{ data: {} }], [{ text: 'P-101 A/B' }]);
    const s = await presentPublishSummary({ id: ID, ownerId: 'o1' });
    expect(chat).toHaveBeenCalledTimes(1);
    const parts = chat.mock.calls[0]![0].messages[1].content;
    expect(parts[0].text).toContain('P-101 A/B');
    expect(parts[1].imageUrl.url).toMatch(/^data:image\/png;base64,/);
    expect(s).toMatchObject({ source: 'publish', hash: presentSummaryHash(canvas.source) });
  });

  it("keeps an author's summary and a summary of this source, calling nothing", async () => {
    vi.mocked(getPresent).mockResolvedValue(canvas as never);
    rows.push([{ data: { [KEY]: { text: 'Mine.', source: 'author', hash: 'old' } } }]);
    expect(await presentPublishSummary({ id: ID, ownerId: 'o1' })).toBeNull();
    rows.push([
      {
        data: {
          [KEY]: { text: 'Made.', source: 'publish', hash: presentSummaryHash(canvas.source) },
        },
      },
    ]);
    expect(await presentPublishSummary({ id: ID, ownerId: 'o1' })).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('buildPublishSummaryMessages', () => {
  it('fences the material and caps it', () => {
    const { system, user } = buildPublishSummaryMessages({
      nodeId: ID,
      kind: 'app',
      title: 'T',
      body: 'x'.repeat(50_000),
    });
    expect(system).toMatch(/at most 600 characters/);
    expect(typeof user).toBe('string');
    expect((user as string).length).toBeLessThan(PUBLISH_SUMMARY_INPUT_MAX_CHARS + 400);
    expect(user as string).toMatch(/BEGIN RETRIEVED CONTENT/);
  });
});
