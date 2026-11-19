/**
 * Behavioural tests for recall_eval, the retrieval-quality self-check.
 *
 * The tool reads a hand-written gold set (a note tagged `recall-eval-cases`),
 * runs each query through the shipped retrievers and writes ONE run note. It
 * is fired from a scheduled heartbeat, so the properties that matter are the
 * ones that decide whether the owner gets nagged and whether their gold set
 * survives:
 *
 *  - The eval never mutates a map. The only write is `createNote` with the
 *    run tag; the gold note is read, never updated, and no other table is
 *    touched. A self-check that rewrote its own gold set would score itself.
 *  - No gold set is SILENCE, not an error: `skipped: true, alert: false`,
 *    nothing embedded, nothing written. (The old ok:false made the weekly
 *    heartbeat alert on every fresh brain.)
 *  - An invalid gold set or a dead embedder refuse before any run note is
 *    written, each with a corrective message.
 *  - Every lookup and retriever call is scoped to the caller's owner id.
 *  - Drift vs the previous run drives `alert`; without a previous run there
 *    is no drift and no alert.
 *  - Gold is resolved on the brain first (stable keys, live ids, title
 *    substrings; the same `resolveGold` the manual harness uses). A case
 *    whose gold lives nowhere is stale: skipped and named in `staleCases`.
 *  - A gold set where EVERY case is stale alerts on its own, with
 *    `reason: 'gold_set_unmatched'`, and writes no run. Drift reads 0 → 0 as
 *    "no change", which is how a pasted-in set from another brain stayed
 *    silent for nine weekly runs on dev.
 *
 * The db select chain is a queue of result batches (gold note first, previous
 * run second); `db.execute` (gold resolution) answers from NODE_ROWS by its
 * bound parameters; embeddings, both retrievers and createNote are stubbed.
 * The scoring and gold helpers from @mantle/search are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const selectQueue: unknown[][] = [];
const whereArgs: unknown[] = [];

/** The nodes gold resolution sees, with their stable keys. */
const NODE_ROWS = [
  { id: 'n1', type: 'page', title: 'Q3 report', title_key: 'tk-q3', body_key: 'bk-q3' },
  { id: 'n2', type: 'note', title: 'Board minutes', title_key: 'tk-board', body_key: null },
];

/** Bound parameter values of a drizzle SQL tree, in order. */
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const o = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
  if (Array.isArray(o.queryChunks)) for (const c of o.queryChunks) paramsOf(c, out);
  else if ('value' in o && 'encoder' in o) out.push(o.value);
  return out;
}

/** Answers resolveGold's three reads: keys by id, keys by type, ids by a
 *  title substring. Each is scoped to the owner (the first parameter). */
function fakeExecute(q: unknown): unknown[] {
  const [owner, ...rest] = paramsOf(q) as string[];
  if (owner !== 'o1') return [];
  const byKey = NODE_ROWS.filter((r) => rest.includes(r.id) || rest.includes(r.type));
  if (byKey.length) return byKey;
  return NODE_ROWS.filter((r) => r.title.toLowerCase().includes(rest[0]!.toLowerCase()));
}

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, arg: unknown) {
      whereArgs.push(arg);
      return this;
    }),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
      Promise.resolve(selectQueue.shift() ?? []).then(res, rej),
  };
  return {
    ...actual,
    db: {
      ...actual.db,
      select: vi.fn(() => chain),
      execute: vi.fn(async (q: unknown) => fakeExecute(q)),
      update: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
    },
  };
});
vi.mock('@mantle/embeddings', () => ({ embed: vi.fn() }));
vi.mock('@mantle/search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/search')>();
  return { ...actual, searchNodes: vi.fn(), searchChunks: vi.fn() };
});
vi.mock('@mantle/content', () => ({ createNote: vi.fn() }));
vi.mock('@mantle/decisions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/decisions')>()),
  decisionUseEnabled: vi.fn(),
  scorePassages: vi.fn(),
}));

import * as dbmod from '@mantle/db';
import { embed } from '@mantle/embeddings';
import { searchChunks, searchNodes } from '@mantle/search';
import { createNote } from '@mantle/content';
import { decisionUseEnabled, scorePassages } from '@mantle/decisions';
import { EVAL_TOOLS } from './builtins-eval';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const evalTool = EVAL_TOOLS.find((t) => t.slug === 'recall_eval')!;
const ctx: ToolHandlerContext = { ownerId: 'o1' };

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const CASES = [{ id: 'q3', query: 'Q3 revenue', expectNodeIds: ['n1'] }];
/** A gold note whose content is the JSON (optionally fenced, as the UI saves it). */
const goldNote = (json: unknown, fence = false) => ({
  id: 'gold-1',
  data: { content: fence ? `\`\`\`json\n${JSON.stringify(json)}\n\`\`\`` : JSON.stringify(json) },
});
const prevRun = (mrr: number, recallAt5: number) => ({
  id: 'run-0',
  data: {
    content: JSON.stringify({
      at: '2026-08-01T00:00:00.000Z',
      casesUsed: 1,
      casesSkipped: 0,
      search: { mrr, recallAt5, recallAt1: mrr, recallAt10: recallAt5 },
      chunks: { mrr, recallAt5, recallAt1: mrr, recallAt10: recallAt5 },
    }),
  },
});

function expectNoWrites(): void {
  expect(createNote).not.toHaveBeenCalled();
  expect(dbmod.db.update).not.toHaveBeenCalled();
  expect(dbmod.db.insert).not.toHaveBeenCalled();
  expect(dbmod.db.delete).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  whereArgs.length = 0;
  vi.mocked(embed).mockResolvedValue([0.1, 0.2]);
  vi.mocked(searchNodes).mockResolvedValue([{ id: 'n1', title: 'Q3 report' }] as never);
  vi.mocked(searchChunks).mockResolvedValue([
    { nodeId: 'n9', nodeTitle: 'Other' },
    { nodeId: 'n1', nodeTitle: 'Q3 report' },
    { nodeId: 'n1', nodeTitle: 'Q3 report' },
  ] as never);
  vi.mocked(createNote).mockResolvedValue({ id: 'run-1' } as never);
  vi.mocked(decisionUseEnabled).mockResolvedValue(null);
});

describe('recall_eval', () => {
  it('skips quietly with no gold set: nothing embedded, nothing written, no alert', async () => {
    selectQueue.push([]);
    expect(outputOf(await evalTool.handler({}, ctx))).toMatchObject({
      skipped: true,
      reason: 'no_golden_cases',
      alert: false,
    });
    expect(embed).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('looks the gold note up under the caller owner only', async () => {
    selectQueue.push([]);
    await evalTool.handler({}, ctx);
    expect(paramsOf(whereArgs[0])).toEqual(['o1', 'note']);
  });

  it('refuses an invalid gold set with a corrective message and writes no run', async () => {
    selectQueue.push([goldNote({ not: 'an array' })]);
    expect(errorOf(await evalTool.handler({}, ctx))).toMatch(
      /golden-case note is invalid: cases must be a JSON array/,
    );
    expect(embed).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('reports the embedder down when every case fails to embed, and writes no run', async () => {
    selectQueue.push([goldNote(CASES)]);
    vi.mocked(embed).mockRejectedValue(new Error('ECONNREFUSED'));
    expect(errorOf(await evalTool.handler({}, ctx))).toMatch(/every case failed to embed/);
    expect(searchNodes).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('scores under the caller owner and writes exactly one run note, never the gold note', async () => {
    selectQueue.push([goldNote(CASES, true)], []);
    const out = outputOf(await evalTool.handler({}, ctx));

    expect(out).toMatchObject({
      casesUsed: 1,
      casesSkipped: 0,
      search: { mrr: 1, recallAt5: 1 },
      chunks: { mrr: 0.5, recallAt5: 1 },
      drift: null,
      alert: false,
      runNoteId: 'run-1',
    });
    expect(embed).toHaveBeenCalledWith('o1', 'Q3 revenue');
    expect(searchNodes).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'o1', q: 'Q3 revenue' }),
    );
    // Passages: the hybrid path agents use (q set), and vector-only beside it.
    expect(searchChunks).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'o1', q: 'Q3 revenue' }),
    );
    expect(vi.mocked(searchChunks).mock.calls.some(([a]) => a.q === undefined)).toBe(true);
    expect(out).toMatchObject({ chunksPath: 'hybrid', chunksVector: { mrr: 0.5 } });
    expect(out).not.toHaveProperty('chunksScored');
    expect(scorePassages).not.toHaveBeenCalled();

    // The one write: a NEW note carrying only the run tag. The gold note's id
    // never reaches a write, and no other table is touched.
    expect(createNote).toHaveBeenCalledTimes(1);
    const [owner, note] = vi.mocked(createNote).mock.calls[0]!;
    expect(owner).toBe('o1');
    expect(note.tags).toEqual(['recall-eval-run']);
    expect(note.title).toMatch(/^Recall eval/);
    expect(JSON.parse(note.content as string)).toMatchObject({ casesUsed: 1 });
    expect(JSON.stringify(note)).not.toContain('gold-1');
    expect(dbmod.db.update).not.toHaveBeenCalled();
    expect(dbmod.db.insert).not.toHaveBeenCalled();
    expect(dbmod.db.delete).not.toHaveBeenCalled();
  });

  it('alerts when quality fell against the previous run', async () => {
    selectQueue.push([goldNote(CASES)], [prevRun(1, 1)]);
    vi.mocked(searchNodes).mockResolvedValue([]);
    const out = outputOf(await evalTool.handler({}, ctx));
    expect(out.drift).toMatchObject({
      searchMrr: -1,
      searchR5: -1,
      previousAt: '2026-08-01T00:00:00.000Z',
    });
    expect(out.alert).toBe(true);
  });

  it('stays quiet when the previous run scored the same', async () => {
    selectQueue.push([goldNote(CASES)], [prevRun(1, 1)]);
    const out = outputOf(await evalTool.handler({}, ctx));
    expect(out.drift).toMatchObject({ searchMrr: 0, searchR5: 0 });
    expect(out.alert).toBe(false);
    expect(out.reason).toBeNull();
    expect(out.unmatchedCases).toEqual([]);
  });

  it('names the drift reason when quality fell', async () => {
    selectQueue.push([goldNote(CASES)], [prevRun(1, 1)]);
    vi.mocked(searchNodes).mockResolvedValue([]);
    const out = outputOf(await evalTool.handler({}, ctx));
    expect(out.alert).toBe(true);
    expect(out.reason).toBe('quality_dropped');
    // The chunk arm still ranked the case, so the gold set is not unmatched.
    expect(out.unmatchedCases).toEqual([]);
  });

  it('a live case that every retriever misses is a real miss: scored, named, no stale alert', async () => {
    selectQueue.push(
      [goldNote([...CASES, { id: 'x', query: 'other', expectTitleIncludes: ['board'] }])],
      [],
    );
    vi.mocked(searchNodes).mockResolvedValue([{ id: 'n7', title: 'Unrelated' }] as never);
    vi.mocked(searchChunks).mockResolvedValue([{ nodeId: 'n8', nodeTitle: 'Also not' }] as never);
    const out = outputOf(await evalTool.handler({}, ctx));

    expect(out).toMatchObject({
      casesUsed: 2,
      staleCases: [],
      search: { mrr: 0, recallAt10: 0 },
      alert: false,
      reason: null,
      unmatchedCases: ['q3', 'x'],
    });
    expect(createNote).toHaveBeenCalledTimes(1);
  });

  it('matches gold by stable key: a re-made item with a new id still counts', async () => {
    selectQueue.push(
      [goldNote([{ id: 'k', query: 'Q3 revenue', expect: [{ type: 'page', titleKey: 'tk-q3' }] }])],
      [],
    );
    const out = outputOf(await evalTool.handler({}, ctx));
    expect(out).toMatchObject({ casesUsed: 1, staleCases: [], search: { mrr: 1 } });
  });

  it('a key of the wrong type, or with a hash nothing has, is stale', async () => {
    selectQueue.push(
      [
        goldNote([
          ...CASES,
          { id: 'wrong-type', query: 'a', expect: [{ type: 'note', titleKey: 'tk-q3' }] },
          { id: 'gone', query: 'b', expect: [{ type: 'page', bodyKey: 'bk-deleted' }] },
        ]),
      ],
      [],
    );
    const out = outputOf(await evalTool.handler({}, ctx));
    expect(out).toMatchObject({
      casesUsed: 1,
      staleCases: ['wrong-type', 'gone'],
      alert: false,
    });
    expect(out.detail).toMatch(/2 stale case\(s\) skipped.*wrong-type, gone/);
    expect(embed).toHaveBeenCalledTimes(1);
    const [, note] = vi.mocked(createNote).mock.calls[0]!;
    expect(JSON.parse(note.content as string)).toMatchObject({
      staleCases: ['wrong-type', 'gone'],
    });
  });

  it('alerts gold_set_unmatched when EVERY case is stale, and runs and writes nothing', async () => {
    selectQueue.push(
      [
        goldNote([
          { id: 'a', query: 'q', expectNodeIds: ['deleted-id'] },
          { id: 'b', query: 'q', expectTitleIncludes: ['nowhere'] },
          { id: 'c', query: 'q', expect: [{ type: 'page', titleKey: 'tk-gone' }] },
        ]),
      ],
      [prevRun(1, 1)],
    );
    const out = outputOf(await evalTool.handler({}, ctx));
    expect(out).toMatchObject({
      alert: true,
      reason: 'gold_set_unmatched',
      staleCases: ['a', 'b', 'c'],
    });
    expect(out.detail).toMatch(/recall-eval-cases/);
    expect(out.detail).toMatch(/--keys/);
    expect(embed).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('resolves gold under the caller owner only', async () => {
    selectQueue.push([goldNote(CASES)], []);
    await evalTool.handler({}, ctx);
    for (const [q] of vi.mocked(dbmod.db.execute).mock.calls) expect(paramsOf(q)[0]).toBe('o1');
  });

  it('does not call the gold set unmatched while any case still ranks somewhere', async () => {
    selectQueue.push(
      [goldNote([...CASES, { id: 'x', query: 'other', expectNodeIds: ['n2'] }])],
      [],
    );
    // 'q3' ranks only in the chunk arm; 'x' ranks nowhere.
    vi.mocked(searchNodes).mockResolvedValue([]);
    const out = outputOf(await evalTool.handler({}, ctx));
    expect(out.alert).toBe(false);
    expect(out.reason).toBeNull();
    expect(out.unmatchedCases).toEqual(['x']);
  });

  it('skips a case whose embedding fails and scores the rest', async () => {
    selectQueue.push(
      [goldNote([...CASES, { id: 'x', query: 'other', expectNodeIds: ['n2'] }])],
      [],
    );
    vi.mocked(embed).mockResolvedValueOnce([0.1]).mockRejectedValueOnce(new Error('timeout'));
    expect(outputOf(await evalTool.handler({}, ctx))).toMatchObject({
      casesUsed: 1,
      casesSkipped: 1,
    });
    expect(searchNodes).toHaveBeenCalledTimes(1);
  });

  it('reads chunks drift only against a run that measured the hybrid path too', async () => {
    selectQueue.push([goldNote(CASES)], [prevRun(1, 1)]);
    expect(
      (outputOf(await evalTool.handler({}, ctx)).drift as { chunksMrr: unknown }).chunksMrr,
    ).toBeNull();

    const hybridPrev = prevRun(1, 1);
    const content = JSON.parse(hybridPrev.data.content);
    hybridPrev.data.content = JSON.stringify({ ...content, chunksPath: 'hybrid' });
    selectQueue.push([goldNote(CASES)], [hybridPrev]);
    expect(outputOf(await evalTool.handler({}, ctx)).drift).toMatchObject({ chunksMrr: -0.5 });
  });

  it('with a passage_scoring pool set, scores the deeper hybrid pool and says the cost', async () => {
    selectQueue.push([goldNote(CASES)], []);
    vi.mocked(decisionUseEnabled).mockResolvedValue({ mode: 'shadow', pool: 50 } as never);
    // Search order puts the gold node second; Jev scores it first.
    vi.mocked(searchChunks).mockResolvedValue([
      { nodeId: 'n9', nodeTitle: 'Other', ordinal: 0, text: 'x', headingPath: null },
      { nodeId: 'n1', nodeTitle: 'Q3 report', ordinal: 2, text: 'y', headingPath: null },
    ] as never);
    vi.mocked(scorePassages).mockResolvedValue({
      scores: new Map([
        ['n9:0', { score: 0.2, confidence: 0.9 }],
        ['n1:2', { score: 2.8, confidence: 0.9 }],
      ]),
      mode: 'shadow',
      threshold: 1.5,
      cached: false,
      ms: 600,
    });
    const out = outputOf(await evalTool.handler({}, ctx));
    expect(searchChunks).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'Q3 revenue', limit: 50 }),
    );
    expect(scorePassages).toHaveBeenCalledWith('o1', 'Q3 revenue', expect.any(Array));
    expect(out).toMatchObject({
      chunks: { mrr: 0.5 },
      chunksScored: { mrr: 1, mode: 'shadow', pool: 50, requests: 1, failed: 0, usd: 0.0007 },
    });
  });
});
