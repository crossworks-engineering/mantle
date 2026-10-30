import { beforeEach, describe, expect, it, vi } from 'vitest';

// Context pruning and version grouping through the request planner: the
// request each sends with no limit, and the split under a question limit.
const h = vi.hoisted(() => ({
  calls: [] as Array<{ state: any; questions: Record<string, any>; input: any }>,
  limits: null as null | { model: string; limits: Record<string, unknown> },
}));

vi.mock('./decide', () => ({
  deciderRequestLimits: vi.fn(async () => h.limits),
  DecideBatch: class {
    skipped = 0;
    note() {}
    settle() {}
  },
  decide: vi.fn(async (input: any) => {
    h.calls.push({ state: input.state, questions: input.questions, input });
    const answers = Object.fromEntries(
      Object.entries(input.questions).map(([k, q]: [string, any]) => [
        k,
        q.type === 'noul'
          ? { type: 'noul', probability: 0.95 }
          : { type: 'score', score: 2, confidence: 0.9, probabilities: {} },
      ]),
    );
    return {
      answers,
      mode: 'live',
      use: { enabled: true, mode: 'live', threshold: undefined, deferBelow: 0.6, actAloneAt: 0.9 },
      model: 'm',
      cached: false,
      ms: 50,
    };
  }),
}));

import { scoreContextItems } from './context-pruning';
import { groupVersions } from './version-grouping';

const sixteen = {
  model: 'm',
  limits: { maxQuestions: 16, maxInputTokens: null, cutAt: null, source: 'careful' },
};

beforeEach(() => {
  h.calls.length = 0;
  h.limits = null;
});

describe('scoreContextItems', () => {
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `i${i}`,
      block: (['fact', 'hit', 'chunk'] as const)[i % 3]!,
      text: `item ${i}`,
    }));

  it('one request with no limit, keyed by block and position', async () => {
    const r = await scoreContextItems('o', 'q', items(3));
    expect(h.calls).toHaveLength(1);
    expect(Object.keys(h.calls[0]!.questions)).toEqual(['f1', 'h2', 'c3']);
    expect(h.calls[0]!.state).toEqual({
      question: 'q',
      items: { f1: 'item 0', h2: 'item 1', c3: 'item 2' },
    });
    expect(h.calls[0]!.input.batch).toBeUndefined();
    expect(r?.scores.size).toBe(3);
  });

  it('splits 40 items for a model that takes 16 questions, and scores them all', async () => {
    h.limits = sixteen;
    const r = await scoreContextItems('o', 'q', items(40));
    expect(h.calls.map((c) => Object.keys(c.questions).length)).toEqual([14, 14, 12]);
    expect(h.calls.every((c) => c.input.batch && c.input.timeoutFactor === 3)).toBe(true);
    // One reading of the limits governs every request of the plan.
    expect(h.calls.every((c) => c.input.limits?.limits === sixteen.limits)).toBe(true);
    expect(r?.scores.size).toBe(40);
  });
});

describe('groupVersions', () => {
  const passages = Array.from({ length: 6 }, (_, i) => ({
    id: `c${i}`,
    nodeId: `n${i}`,
    title: `doc ${i}`,
    text: `text ${i}`,
  }));

  it('one request with no limit: the used passages in list order, one noul per pair', async () => {
    const pairs = [
      { a: 'c3', b: 'c1', similarity: 0.9 },
      { a: 'c4', b: 'c5', similarity: 0.8 },
    ];
    const r = await groupVersions('o', passages, pairs);
    expect(h.calls).toHaveLength(1);
    expect(Object.keys(h.calls[0]!.state.passages)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(h.calls[0]!.state.passages.p1.document_title).toBe('doc 1');
    expect(h.calls[0]!.questions.q1.instructions).toContain('`passages.p2` and `passages.p1`');
    expect(r?.pairs.map((p) => [p.a, p.b])).toEqual([
      ['c3', 'c1'],
      ['c4', 'c5'],
    ]);
  });

  it('a split request carries only the passages its own pairs name', async () => {
    h.limits = sixteen;
    const pairs = Array.from({ length: 20 }, (_, i) => ({
      a: `c${i % 6}`,
      b: `c${(i + 1) % 6}`,
      similarity: 0.9,
    }));
    const r = await groupVersions('o', passages, pairs);
    expect(h.calls.length).toBe(2);
    for (const c of h.calls) {
      const named = new Set(
        Object.values(c.questions).flatMap((q: any) =>
          [...String(q.instructions).matchAll(/passages\.(p\d+)/g)].map((m) => m[1]),
        ),
      );
      expect(new Set(Object.keys(c.state.passages))).toEqual(named);
    }
    // Every pair answered, in the order asked.
    expect(r?.pairs).toHaveLength(20);
    expect(r?.pairs[19]).toMatchObject({ a: 'c1', b: 'c2' });
  });
});
