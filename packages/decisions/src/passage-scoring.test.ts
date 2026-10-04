import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ state: any; questions: Record<string, unknown>; input: any }>,
  failGroup: -1,
}));

vi.mock('./decide', () => ({
  DecideBatch: class {
    skipped = 0;
    note() {}
    settle() {}
  },
  decide: vi.fn(async (input: any) => {
    const i = h.calls.length;
    h.calls.push({ state: input.state, questions: input.questions, input });
    if (i === h.failGroup) return null;
    const answers = Object.fromEntries(
      Object.keys(input.questions).map((k) => [
        k,
        { type: 'score', score: 2, confidence: 0.9, probabilities: {} },
      ]),
    );
    return {
      answers,
      mode: 'live',
      use: { enabled: true, mode: 'live', threshold: 2, deferBelow: 0.6, actAloneAt: 0.9 },
      model: 'jev',
      cached: false,
      ms: 100,
    };
  }),
}));

import {
  MAX_PASSAGE_POOL,
  MAX_PASSAGES_PER_REQUEST,
  passageScoringPool,
  scorePassages,
} from './passage-scoring';

const passages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, title: `doc ${i}`, text: `text ${i}` }));

beforeEach(() => {
  h.calls.length = 0;
  h.failGroup = -1;
});

describe('passageScoringPool', () => {
  it('unset pool keeps the original max(2 x limit, 16) capped at one request', () => {
    expect(passageScoringPool({}, 8)).toBe(16);
    expect(passageScoringPool({}, 10)).toBe(20);
    expect(passageScoringPool({}, 20)).toBe(MAX_PASSAGES_PER_REQUEST);
    expect(passageScoringPool(null, 8)).toBe(16);
  });

  it('a set pool wins, capped at MAX_PASSAGE_POOL and never below the limit', () => {
    expect(passageScoringPool({ pool: 50 }, 10)).toBe(50);
    expect(passageScoringPool({ pool: 200 }, 10)).toBe(200);
    expect(passageScoringPool({ pool: 500 }, 10)).toBe(MAX_PASSAGE_POOL);
    expect(passageScoringPool({ pool: 5 }, 10)).toBe(10);
  });

  it('passage windows double the pool (each arm brings it), still capped', () => {
    expect(passageScoringPool({ pool: 50 }, 10, { windows: true })).toBe(100);
    expect(passageScoringPool({}, 8, { windows: true })).toBe(32);
    expect(passageScoringPool({ pool: 150 }, 10, { windows: true })).toBe(MAX_PASSAGE_POOL);
    expect(passageScoringPool({ pool: 50 }, 10, { windows: false })).toBe(50);
  });
});

describe('scorePassages', () => {
  it('a short list is one request, with no fan-out batch or timeout factor', async () => {
    const r = await scorePassages('o', 'q', passages(20));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.input.batch).toBeUndefined();
    expect(h.calls[0]!.input.timeoutFactor).toBeUndefined();
    expect(r?.scores.size).toBe(20);
    expect(r).toMatchObject({ mode: 'live', threshold: 2 });
  });

  it('a pool past one request fans out in requests of 25, timeout scaled per request', async () => {
    const r = await scorePassages('o', 'q', passages(50));
    expect(h.calls).toHaveLength(2);
    expect(h.calls.map((c) => Object.keys(c.questions).length)).toEqual([25, 25]);
    expect(h.calls.every((c) => c.input.batch && c.input.timeoutFactor === 2)).toBe(true);
    // Each request numbers its own passages from p1.
    expect(Object.keys(h.calls[1]!.state.passages)[0]).toBe('p1');
    expect(r?.scores.size).toBe(50);
    expect(r?.scores.has('c49')).toBe(true);
  });

  it('a failed request leaves its passages unscored; the rest still count', async () => {
    h.failGroup = 1;
    const r = await scorePassages('o', 'q', passages(50));
    expect(r?.scores.size).toBe(25);
    expect(r?.scores.has('c0')).toBe(true);
    expect(r?.scores.has('c30')).toBe(false);
  });

  it('never sends more than MAX_PASSAGE_POOL passages', async () => {
    await scorePassages('o', 'q', passages(MAX_PASSAGE_POOL + 30));
    const sent = h.calls.reduce((n, c) => n + Object.keys(c.questions).length, 0);
    expect(sent).toBe(MAX_PASSAGE_POOL);
  });

  it('no passages or no question: no request', async () => {
    expect(await scorePassages('o', 'q', [])).toBeNull();
    expect(await scorePassages('o', '  ', passages(3))).toBeNull();
    expect(h.calls).toHaveLength(0);
  });
});
