import { beforeEach, describe, expect, it, vi } from 'vitest';

// writeLearnedEntries with its edges stubbed: the Journal read (what the agent
// already knows) and the Journal write.
const h = vi.hoisted(() => ({
  known: [] as Array<{ data: Record<string, unknown> }>,
  existing: [] as Array<{ ref: string }>,
  created: [] as Array<Record<string, unknown>>,
  rules: [] as Array<{ id: string; kind: string; body: string; createdAt: Date }>,
  superseded: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mantle/db', async () => {
  const actual = await vi.importActual<typeof import('@mantle/db')>('@mantle/db');
  // `where` ends the apply's query (already-converted refs); `limit` ends
  // the known-entries query.
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => h.known,
    then: (res: (v: unknown) => unknown) => res(h.existing),
  };
  return { ...actual, db: { select: () => chain } };
});
vi.mock('./journal', async () => {
  const actual = await vi.importActual<typeof import('./journal')>('./journal');
  return {
    ...actual,
    createJournal: vi.fn(async (_owner: string, e: Record<string, unknown>) => {
      h.created.push(e);
      return { id: `j${h.created.length}` };
    }),
  };
});

vi.mock('./rule-reconcile', async () => {
  const actual = await vi.importActual<typeof import('./rule-reconcile')>('./rule-reconcile');
  return { ...actual, loadLearnedRules: vi.fn(async () => h.rules) };
});
vi.mock('./supersede', () => ({
  supersedeNode: vi.fn(async (input: Record<string, unknown>) => {
    h.superseded.push(input);
    return {};
  }),
}));

import { applyConversionPlan, type ConversionPlan } from './persona-notes-journal';
import { writeLearnedEntries } from './persona-notes-journal';

beforeEach(() => {
  h.known = [{ data: { kind: 'preference', body: 'The user prefers British English spelling.' } }];
  h.created = [];
  h.existing = [];
  h.rules = [
    {
      id: 'r1',
      kind: 'preference',
      body: 'The user prefers British English spelling.',
      createdAt: new Date('2026-09-01T00:00:00Z'),
    },
  ];
  h.superseded = [];
});

describe('applyConversionPlan', () => {
  const entry = (ref: string, extra: Record<string, unknown> = {}) => ({
    ref,
    content: `${ref} rule`,
    noteKind: 'style',
    kind: 'preference',
    scope: 'general' as const,
    topic: '',
    ...extra,
  });
  const plan = (entries: ReturnType<typeof entry>[]): ConversionPlan => ({
    version: 1,
    agentId: 'ag1',
    agentSlug: 'assistant',
    createdAt: '2026-09-23T00:00:00Z',
    model: 'm',
    entries,
  });

  it('creates each ref once, skips duplicates, retired notes and what already exists', async () => {
    h.existing = [{ ref: 'done' }];
    const r = await applyConversionPlan(
      'o1',
      plan([
        entry('a'),
        entry('a'), // two id-less notes with the same text share a ref
        entry('b', { duplicateOf: 'a' }),
        entry('gone'),
        entry('done'),
      ]),
      { skipRefs: new Set(['gone']) },
    );
    expect(r).toEqual({ created: 1, existing: 2, duplicates: 1, skipped: 1 });
    expect(h.created.map((e) => e.body)).toEqual(['a rule']);
    expect(h.created[0]).toMatchObject({ author: 'agent', agentSlug: 'assistant' });
  });

  it('a duplicate whose kept note was retired since the dry run takes its place', async () => {
    const r = await applyConversionPlan(
      'o1',
      plan([
        entry('kept', { kind: 'preference', scope: 'general' }),
        entry('copy1', { duplicateOf: 'kept', kind: 'expectation', scope: 'topic' }),
        entry('copy2', { duplicateOf: 'kept' }),
      ]),
      { skipRefs: new Set(['kept']) },
    );
    expect(h.created.map((e) => e.body)).toEqual(['copy1 rule']);
    // It takes the kept note's reviewed kind: a correction stays always on.
    expect(h.created[0]).toMatchObject({ kind: 'preference' });
    expect(r).toEqual({ created: 1, existing: 0, duplicates: 1, skipped: 1 });
  });

  it('a second apply of the same plan creates nothing', async () => {
    h.existing = [{ ref: 'a' }];
    const r = await applyConversionPlan('o1', plan([entry('a')]));
    expect(r.created).toBe(0);
    expect(r.existing).toBe(1);
  });
});

import type { RuleReconciler } from './rule-reconcile';

/** A reconciler whose vectors put every text on top of each other (all
 *  pairs clear the similarity floor) and whose decider returns `score`. */
function reconciler(
  mode: 'shadow' | 'live',
  score: { same: number; replaces: number } | null,
  opts: { failEmbed?: boolean } = {},
): RuleReconciler & { asked: Array<{ older: string; newer: string }> } {
  const asked: Array<{ older: string; newer: string }> = [];
  return {
    asked,
    similarityFloor: 0.7,
    embed: async (texts) => {
      if (opts.failEmbed) throw new Error('embedder down');
      return texts.map(() => [1, 0]);
    },
    judge: async (pairs) => {
      asked.push(...pairs);
      if (!score) return null;
      return { scores: pairs.map(() => score), mode, threshold: 0.8, calls: 1, failed: 0, ms: 300 };
    },
  };
}

describe('writeLearnedEntries', () => {
  const correction = { kind: 'correction', content: 'The user prefers American English spelling.' };

  it('an explicit update_persona add is always written, even when it reads like a copy', async () => {
    const w = await writeLearnedEntries('o1', 'assistant', [correction], 'update_persona');
    expect(w).toEqual({
      written: [{ id: 'j1', kind: 'preference', content: correction.content }],
      reconcile: null,
    });
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ author: 'agent', agentSlug: 'assistant' });
  });

  it('the reflector still skips a near-copy of what the agent knows', async () => {
    const w = await writeLearnedEntries(
      'o1',
      'assistant',
      [{ kind: 'style', content: 'The user prefers British English spelling.' }],
      'reflector',
    );
    expect(w.written).toEqual([]);
    expect(h.created).toHaveLength(0);
  });

  it('live: a correction the backstop reads as a copy lands and retires the old rule', async () => {
    const rec = reconciler('live', { same: 0.1, replaces: 0.93 });
    const w = await writeLearnedEntries('o1', 'assistant', [correction], 'reflector', {
      reconcile: rec,
    });
    expect(rec.asked).toEqual([
      { older: 'The user prefers British English spelling.', newer: correction.content },
    ]);
    expect(w.written.map((e) => e.content)).toEqual([correction.content]);
    expect(h.superseded).toEqual([
      { ownerId: 'o1', id: 'r1', supersededBy: 'j1', reason: 'corrected' },
    ]);
    expect(w.reconcile).toMatchObject({ mode: 'live', pairs: 1, errors: 0 });
    expect(w.reconcile!.retires).toMatchObject([{ olderId: 'r1', newerId: 'j1', replaces: 0.93 }]);
  });

  it('live: a same-rule match is a version, not a correction', async () => {
    const note = { kind: 'style', content: 'Tables always cite their source row.' };
    await writeLearnedEntries('o1', 'assistant', [note], 'update_persona', {
      reconcile: reconciler('live', { same: 0.86, replaces: 0.05 }),
    });
    expect(h.superseded).toEqual([
      { ownerId: 'o1', id: 'r1', supersededBy: 'j1', reason: 'version' },
    ]);
  });

  it('shadow: nothing is retired, and the backstop still drops a copy', async () => {
    const w = await writeLearnedEntries('o1', 'assistant', [correction], 'reflector', {
      reconcile: reconciler('shadow', { same: 0.1, replaces: 0.93 }),
    });
    expect(w.written).toEqual([]);
    expect(h.superseded).toEqual([]);
    // The dropped note was never written, so it retires nothing even on paper.
    expect(w.reconcile).toMatchObject({ mode: 'shadow', pairs: 1, retires: [] });
  });

  it('shadow: a written rule reports its would-be retire', async () => {
    const note = { kind: 'style', content: 'Tables always cite their source row.' };
    const w = await writeLearnedEntries('o1', 'assistant', [note], 'reflector', {
      reconcile: reconciler('shadow', { same: 0.86, replaces: 0.05 }),
    });
    expect(w.written).toHaveLength(1);
    expect(h.superseded).toEqual([]);
    expect(w.reconcile!.retires).toMatchObject([{ olderId: 'r1', newerId: 'j1', same: 0.86 }]);
  });

  it('below the gate nothing is retired', async () => {
    const note = { kind: 'style', content: 'Tables always cite their source row.' };
    const w = await writeLearnedEntries('o1', 'assistant', [note], 'update_persona', {
      reconcile: reconciler('live', { same: 0.79, replaces: 0.79 }),
    });
    expect(h.superseded).toEqual([]);
    expect(w.reconcile!.retires).toEqual([]);
  });

  it('no decider answer, or a failing embedder, writes as before', async () => {
    const off = await writeLearnedEntries('o1', 'assistant', [correction], 'update_persona', {
      reconcile: reconciler('live', null),
    });
    expect(off).toMatchObject({ reconcile: null, written: [{ content: correction.content }] });
    const broken = await writeLearnedEntries('o1', 'assistant', [correction], 'update_persona', {
      reconcile: reconciler('live', { same: 1, replaces: 1 }, { failEmbed: true }),
    });
    expect(broken.reconcile).toBeNull();
    expect(h.created).toHaveLength(2);
    expect(h.superseded).toEqual([]);
  });

  it('an agent with no learned rules asks nothing', async () => {
    h.rules = [];
    const rec = reconciler('live', { same: 1, replaces: 1 });
    const w = await writeLearnedEntries('o1', 'assistant', [correction], 'update_persona', {
      reconcile: rec,
    });
    expect(rec.asked).toEqual([]);
    expect(w.reconcile).toBeNull();
  });
});
