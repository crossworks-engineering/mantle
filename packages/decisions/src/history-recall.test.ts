import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ use: string; state: any; questions: Record<string, unknown> }>,
  failGroup: -1,
  score: (_k: string, _i: number) => 2 as number,
}));

vi.mock('./decide', () => ({
  DecideBatch: class {
    skipped = 0;
    note() {}
    settle() {}
  },
  decide: vi.fn(async (input: any) => {
    const i = h.calls.length;
    h.calls.push({ use: input.use, state: input.state, questions: input.questions });
    if (i === h.failGroup) return null;
    const answers = Object.fromEntries(
      Object.keys(input.questions).map((k) => [
        k,
        { type: 'score', score: h.score(k, i), confidence: 0.9, probabilities: {} },
      ]),
    );
    return {
      answers,
      mode: 'shadow',
      use: {
        enabled: true,
        mode: 'shadow',
        threshold: undefined,
        deferBelow: 0.6,
        actAloneAt: 0.9,
      },
      model: 'jev',
      cached: false,
      ms: 100 + i,
    };
  }),
}));

import {
  HISTORY_RECALL_THRESHOLD_DEFAULT,
  MAX_HISTORY_EXCHANGE_CHARS,
  recallExchanges,
  scoreHistoryExchanges,
} from './history-recall';

const ex = (n: number, text = `exchange ${n}`) => ({ id: `e${n}`, text });

beforeEach(() => {
  h.calls.length = 0;
  h.failGroup = -1;
  h.score = () => 2;
});

describe('scoreHistoryExchanges', () => {
  it('sends groups of 10 in parallel under the history_recall use', async () => {
    const r = await scoreHistoryExchanges('o', 'the SOP again', 'USER: hi', [
      ...Array.from({ length: 25 }, (_, i) => ex(i)),
    ]);
    expect(h.calls.map((c) => Object.keys(c.questions).length)).toEqual([10, 10, 5]);
    expect(h.calls.every((c) => c.use === 'history_recall')).toBe(true);
    expect(h.calls[0]!.state).toMatchObject({
      message: 'the SOP again',
      previous_exchange: 'USER: hi',
    });
    expect(r).toMatchObject({ calls: 3, failed: 0, skipped: 0, mode: 'shadow' });
    expect(r!.ms).toBeGreaterThanOrEqual(0);
    expect(r!.threshold).toBe(HISTORY_RECALL_THRESHOLD_DEFAULT);
    expect(r!.scores.size).toBe(25);
  });

  it('caps each exchange text', async () => {
    await scoreHistoryExchanges('o', 'q', null, [ex(1, 'x'.repeat(9_000))]);
    expect(h.calls[0]!.state.exchanges.x1).toHaveLength(MAX_HISTORY_EXCHANGE_CHARS);
    expect(h.calls[0]!.state.previous_exchange).toBe('');
  });

  it('a failed group leaves its exchanges unscored; all failed = null', async () => {
    h.failGroup = 1;
    const r = await scoreHistoryExchanges(
      'o',
      'q',
      null,
      Array.from({ length: 15 }, (_, i) => ex(i)),
    );
    expect(r).toMatchObject({ calls: 2, failed: 1 });
    expect(r!.scores.has('e0')).toBe(true);
    expect(r!.scores.has('e12')).toBe(false);
    h.calls.length = 0;
    h.failGroup = 0;
    expect(await scoreHistoryExchanges('o', 'q', null, [ex(1)])).toBeNull();
  });

  it('nothing to score = null, no call', async () => {
    expect(await scoreHistoryExchanges('o', 'q', null, [])).toBeNull();
    expect(await scoreHistoryExchanges('o', '  ', null, [ex(1)])).toBeNull();
    expect(h.calls).toHaveLength(0);
  });
});

describe('recallExchanges', () => {
  it('keeps scored-at-threshold items in time order; unscored stay out', () => {
    const older = [ex(1), ex(2), ex(3), ex(4)];
    const scores = new Map([
      ['e1', 2.5],
      ['e2', 0.4],
      ['e4', 1.0],
    ]);
    const r = recallExchanges(older, (e) => e.id, { scores, threshold: 1.0 });
    expect(r.kept.map((e) => e.id)).toEqual(['e1', 'e4']);
    expect(r.dropped.map((e) => e.id)).toEqual(['e2', 'e3']);
  });
});
