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
 *
 * The db select chain is a queue of result batches (gold note first, previous
 * run second); embeddings, both retrievers and createNote are stubbed. The
 * scoring helpers from @mantle/search are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const selectQueue: unknown[][] = [];
const whereArgs: unknown[] = [];

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

import * as dbmod from '@mantle/db';
import { embed } from '@mantle/embeddings';
import { searchChunks, searchNodes } from '@mantle/search';
import { createNote } from '@mantle/content';
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

/** Bound parameter values of a drizzle SQL tree, in order. */
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const o = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
  if (Array.isArray(o.queryChunks)) for (const c of o.queryChunks) paramsOf(c, out);
  else if ('value' in o && 'encoder' in o) out.push(o.value);
  return out;
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
    expect(searchChunks).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'o1' }));

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
});
