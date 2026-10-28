/**
 * An app's generated summary in its extract job (Journal v3 J9): when the
 * summarizer is called and with what. No live model: the chat adapter is a
 * stub. Pinned:
 *
 *  - an app never published, one whose code and manifest the kept summary
 *    was made from, one with its author's summary, one no assistant reads,
 *    and a brain with no summarizer wired: no call;
 *  - otherwise ONE call on the summarizer worker's model, its input capped
 *    and fenced, its answer written at once as a 'publish' summary;
 *  - a failed call, an empty reply or a failed write is { status:
 *    'failed' }, never a throw (a pg-boss retry must not pay again).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[][],
  writes: [] as unknown[],
  llmWorkAllowed: vi.fn(),
  writePublishedSummary: vi.fn(),
  resolveDefaultWorker: vi.fn(),
  chat: vi.fn(),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => h.rows.shift() ?? [],
  };
  return {
    ...actual,
    db: { select: () => chain },
    llmWorkAllowed: h.llmWorkAllowed,
    writePublishedSummary: h.writePublishedSummary,
    bumpWorkerUsage: vi.fn(async () => undefined),
  };
});
vi.mock('@mantle/api-keys', () => ({ resolveDefaultWorker: h.resolveDefaultWorker }));
vi.mock('@mantle/voice', () => ({ getChatAdapter: vi.fn(() => ({ chat: h.chat })) }));
vi.mock('@mantle/tracing', () => ({
  log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  startTrace: vi.fn(async (_init: unknown, fn: () => unknown) => fn()),
  step: vi.fn(async (_init: unknown, fn: (x: unknown) => unknown) =>
    fn({ setOutput: () => {}, setMeta: () => {} }),
  ),
}));

import { appSummaryHash } from '@mantle/content';
import {
  APP_SUMMARY_INPUT_MAX_CHARS,
  buildAppSummaryMessages,
  summarizeAppForIndex,
} from './app-summary';

const KEY = 'published' + '_summary';
const source = { entry: 'App.tsx', files: { 'App.tsx': 'export default () => null;' } };
const manifest = {
  description: 'Pump log',
  sqlite: { schemaSql: 'CREATE TABLE readings (pump TEXT, mm REAL);', schemaVersion: 1 },
};
const HASH = appSummaryHash(source, manifest as never);
const BUILD = {
  ok: true,
  storageKey: 'k',
  sha256: 's',
  builtAt: 'x',
  esbuildVersion: 'e',
  bytes: 1,
};

function appNode(data: Record<string, unknown> = {}) {
  return { id: 'a1', ownerId: 'o1', type: 'app', title: 'Pumps', data } as never;
}
/** The apps row the job reads, then the node it reads back after a write. */
function appRow(over: Record<string, unknown> = {}) {
  h.rows.push([{ source, manifest, published: BUILD, ...over }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.length = 0;
  h.llmWorkAllowed.mockResolvedValue(true);
  h.writePublishedSummary.mockResolvedValue(true);
  h.resolveDefaultWorker.mockResolvedValue({
    ok: true,
    worker: { id: 'w1', slug: 'summarizer', provider: 'openrouter', model: 'cheap-model' },
    credential: { apiKey: 'not-a-real-key' },
  });
  h.chat.mockResolvedValue({ text: 'Logs pump readings for the crew. Table: readings.' });
});

describe('summarizeAppForIndex', () => {
  it('makes one call on the summarizer worker and writes its answer at once', async () => {
    appRow();
    h.rows.push([{ id: 'a1', data: { fresh: true } }]);
    const out = await summarizeAppForIndex(appNode(), 'o1');
    expect(h.chat).toHaveBeenCalledTimes(1);
    const req = h.chat.mock.calls[0]![0];
    expect(req.model).toBe('cheap-model');
    expect(req.messages[1].content).toContain('CREATE TABLE readings');
    expect(typeof req.messages[1].content).toBe('string');
    expect(h.writePublishedSummary).toHaveBeenCalledTimes(1);
    expect(h.writePublishedSummary.mock.calls[0]![2]).toMatchObject({
      text: 'Logs pump readings for the crew. Table: readings.',
      source: 'publish',
      model: 'cheap-model',
      hash: HASH,
    });
    expect(out.status).toBe('written');
    expect(out.node).toMatchObject({ data: { fresh: true } });
  });

  it('calls nothing for an app never published', async () => {
    appRow({ published: null });
    expect((await summarizeAppForIndex(appNode(), 'o1')).status).toBe('none');
    expect(h.chat).not.toHaveBeenCalled();
  });

  it('calls nothing when the code and manifest are the ones the kept summary was made from', async () => {
    appRow();
    const kept = { text: 'Old.', source: 'publish', hash: HASH, at: 'x', model: 'm' };
    expect((await summarizeAppForIndex(appNode({ [KEY]: kept }), 'o1')).status).toBe('none');
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("never generates over an author's summary", async () => {
    appRow();
    const mine = { text: 'Mine.', source: 'author', hash: 'old', at: 'x', model: null };
    expect((await summarizeAppForIndex(appNode({ [KEY]: mine }), 'o1')).status).toBe('none');
    expect(h.chat).not.toHaveBeenCalled();
  });

  it('calls nothing for an app no assistant reads, nor with no summarizer wired', async () => {
    h.llmWorkAllowed.mockResolvedValueOnce(false);
    appRow();
    expect((await summarizeAppForIndex(appNode(), 'o1')).status).toBe('none');
    h.resolveDefaultWorker.mockResolvedValueOnce({ ok: false, why: 'none', worker: null });
    appRow();
    expect((await summarizeAppForIndex(appNode(), 'o1')).status).toBe('none');
    expect(h.chat).not.toHaveBeenCalled();
  });

  it('a failed call is null and a skip, never a throw, and is not tried again', async () => {
    h.chat.mockRejectedValue(new Error('provider down'));
    appRow();
    const out = await summarizeAppForIndex(appNode(), 'o1');
    expect(out.status).toBe('failed');
    expect(h.chat).toHaveBeenCalledTimes(1);
    expect(h.writePublishedSummary).not.toHaveBeenCalled();
  });

  it('an empty reply, or a write that fails after the call, is failed too, never a throw', async () => {
    h.chat.mockResolvedValueOnce({ text: '   ' });
    appRow();
    expect((await summarizeAppForIndex(appNode(), 'o1')).status).toBe('failed');
    h.writePublishedSummary.mockRejectedValueOnce(new Error('db down'));
    appRow();
    expect((await summarizeAppForIndex(appNode(), 'o1')).status).toBe('failed');
    expect(h.chat).toHaveBeenCalledTimes(2);
  });

  it('is not an app: nothing read, nothing called', async () => {
    const note = { id: 'n1', type: 'note', title: 'x', data: {} } as never;
    expect((await summarizeAppForIndex(note, 'o1')).status).toBe('none');
    expect(h.rows.length).toBe(0);
    expect(h.chat).not.toHaveBeenCalled();
  });
});

describe('buildAppSummaryMessages', () => {
  it('fences the material and caps it', () => {
    const { system, user } = buildAppSummaryMessages('T', 'x'.repeat(50_000));
    expect(system).toMatch(/at most 600 characters/);
    expect(user.length).toBeLessThan(APP_SUMMARY_INPUT_MAX_CHARS + 400);
    expect(user).toMatch(/BEGIN RETRIEVED CONTENT/);
  });
});
