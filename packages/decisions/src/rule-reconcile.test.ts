import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ use: string; state: any; questions: Record<string, any> }>,
  fail: new Set<number>(),
}));

vi.mock('./decide', () => ({
  DecideBatch: class {
    skipped = 0;
    note() {}
    settle() {}
  },
  decide: vi.fn(async (input: any) => {
    const n = h.calls.push({ use: input.use, state: input.state, questions: input.questions });
    if (h.fail.has(n)) return null;
    return {
      // s-questions answer 0.9, r-questions 0.1.
      answers: Object.fromEntries(
        Object.keys(input.questions).map((k) => [
          k,
          { type: 'noul', probability: k.startsWith('s') ? 0.9 : 0.1 },
        ]),
      ),
      mode: 'live',
      use: { enabled: true, mode: 'live', threshold: undefined, deferBelow: 0.6, actAloneAt: 0.9 },
      model: 'jev',
      cached: false,
      ms: 300,
    };
  }),
}));

import {
  MAX_RULE_PAIRS,
  RULE_RECONCILE_THRESHOLD_DEFAULT,
  judgeRulePairs,
  retiresOlder,
} from './rule-reconcile';

beforeEach(() => {
  h.calls.length = 0;
  h.fail.clear();
});

describe('judgeRulePairs', () => {
  const pairs = Array.from({ length: MAX_RULE_PAIRS + 3 }, (_, i) => ({
    older: `old ${i}`,
    newer: `new ${i}`,
  }));

  it('asks two nouls per pair under rule_reconcile, in groups, and names the newer rule', async () => {
    const r = await judgeRulePairs('o', pairs);
    expect(h.calls.map((c) => Object.keys(c.questions).length)).toEqual([MAX_RULE_PAIRS * 2, 6]);
    expect(h.calls.every((c) => c.use === 'rule_reconcile')).toBe(true);
    expect(h.calls[0]!.state.rules).toMatchObject({ a1: 'old 0', b1: 'new 0' });
    expect(h.calls[0]!.questions.r1.instructions).toMatch(/`rules.b1` is newer than `rules.a1`/);
    expect(h.calls[0]!.questions.s1.type).toBe('noul');
    expect(r).toMatchObject({ mode: 'live', calls: 2, failed: 0 });
    expect(r!.threshold).toBe(RULE_RECONCILE_THRESHOLD_DEFAULT);
    expect(r!.scores[MAX_RULE_PAIRS + 2]).toEqual({ same: 0.9, replaces: 0.1 });
  });

  it('a failed group leaves its pairs unscored; all failed = null', async () => {
    h.fail.add(2);
    const r = await judgeRulePairs('o', pairs);
    expect(r!.failed).toBe(1);
    expect(r!.scores[0]).not.toBeNull();
    expect(r!.scores[MAX_RULE_PAIRS]).toBeNull();
    h.calls.length = 0;
    h.fail.clear();
    h.fail.add(1);
    expect(await judgeRulePairs('o', pairs.slice(0, 2))).toBeNull();
  });

  it('nothing to ask = null, no call', async () => {
    expect(await judgeRulePairs('o', [])).toBeNull();
    expect(h.calls).toHaveLength(0);
  });
});

describe('retiresOlder', () => {
  it('the spike gate: either answer at 0.8', () => {
    expect(retiresOlder({ same: 0.8, replaces: 0 }, 0.8)).toBe(true);
    expect(retiresOlder({ same: 0, replaces: 0.8 }, 0.8)).toBe(true);
    expect(retiresOlder({ same: 0.79, replaces: 0.79 }, 0.8)).toBe(false);
    expect(retiresOlder(null, 0.8)).toBe(false);
  });
});
