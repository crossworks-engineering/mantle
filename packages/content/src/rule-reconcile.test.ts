import { describe, expect, it } from 'vitest';
import {
  cosine,
  pairExistingRules,
  pairNewWithExisting,
  pairRetires,
  parseReconcilePlan,
  planRetires,
  renderReconcilePlanMarkdown,
  type ReconcilePlan,
} from './rule-reconcile';

const rule = (id: string, day: number) => ({
  id,
  body: `rule ${id}`,
  createdAt: new Date(Date.UTC(2026, 8, day)),
});

describe('pairing', () => {
  it('cosine is 0 for a zero vector, 1 for the same direction', () => {
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([2, 0], [1, 0])).toBeCloseTo(1);
  });

  it('a new rule pairs with its closest existing rules above the floor, capped', () => {
    const pairs = pairNewWithExisting(
      [[1, 0]],
      [
        [0, 1], // 0.00
        [1, 0.2], // 0.98
        [1, 1], // 0.71
        [1, 0.1], // 0.99
      ],
      0.7,
      2,
    );
    expect(pairs.map((p) => p.ruleIdx)).toEqual([3, 1]);
  });

  it('existing pairs keep the lower index (older) first', () => {
    expect(
      pairExistingRules(
        [
          [1, 0],
          [0, 1],
          [1, 0.1],
        ],
        0.7,
      ),
    ).toEqual([{ a: 0, b: 2, sim: expect.closeTo(0.995, 2) }]);
  });
});

describe('pairRetires', () => {
  it('either answer at the threshold retires; neither does not; no score never does', () => {
    expect(pairRetires({ same: 0.8, replaces: 0 }, 0.8)).toBe(true);
    expect(pairRetires({ same: 0, replaces: 0.8 }, 0.8)).toBe(true);
    expect(pairRetires({ same: 0.79, replaces: 0.79 }, 0.8)).toBe(false);
    expect(pairRetires(null, 0.8)).toBe(false);
  });
});

describe('planRetires', () => {
  const rules = [rule('a', 1), rule('b', 2), rule('c', 3), rule('d', 4)];
  const hit = { same: 0.9, replaces: 0.1 };
  const miss = { same: 0.2, replaces: 0.2 };

  it('an older rule goes to its NEWEST direct replacement', () => {
    const r = planRetires(
      rules,
      [
        { olderIdx: 0, newerIdx: 1, score: hit },
        { olderIdx: 0, newerIdx: 3, score: hit },
      ],
      0.8,
    );
    expect(r.map((x) => [x.olderId, x.newerId])).toEqual([['a', 'd']]);
  });

  it('a replacement that is itself retired hands on to the living end', () => {
    // Tommy's case: a → b → c, each step a direct yes. a ends at c.
    const r = planRetires(
      rules,
      [
        { olderIdx: 0, newerIdx: 1, score: { same: 0.05, replaces: 0.93 } },
        { olderIdx: 1, newerIdx: 2, score: { same: 0.04, replaces: 0.94 } },
      ],
      0.8,
    );
    expect(r.map((x) => [x.olderId, x.newerId])).toEqual([
      ['a', 'c'],
      ['b', 'c'],
    ]);
    expect(r[0]).toMatchObject({ replaces: 0.93 });
  });

  it('pairs below the gate or unanswered retire nothing', () => {
    expect(
      planRetires(
        rules,
        [
          { olderIdx: 0, newerIdx: 1, score: miss },
          { olderIdx: 1, newerIdx: 2, score: null },
        ],
        0.8,
      ),
    ).toEqual([]);
  });
});

describe('the review plan', () => {
  const plan: ReconcilePlan = {
    version: 1,
    agentSlug: 'tommy',
    createdAt: '2026-09-24T00:00:00Z',
    threshold: 0.8,
    rules: 4,
    pairs: 3,
    failedCalls: 0,
    retires: [
      {
        olderId: 'a',
        newerId: 'c',
        older: 'Use | Toggl',
        newer: 'Use a table',
        same: 0.03,
        replaces: 0.94,
      },
    ],
  };

  it('round-trips and refuses a broken plan', () => {
    expect(parseReconcilePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(() => parseReconcilePlan({ ...plan, version: 2 })).toThrow(/version/);
    expect(() =>
      parseReconcilePlan({ ...plan, retires: [{ ...plan.retires[0], newerId: 'a' }] }),
    ).toThrow(/into itself/);
  });

  it('renders the summary and escapes table pipes', () => {
    const md = renderReconcilePlanMarkdown(plan, 'APPLY');
    expect(md).toContain('| Rules to retire | 1 |');
    expect(md).toContain('| of which the newer rule changes it (corrected) | 1 |');
    expect(md).toContain('Use \\| Toggl');
    expect(md).toContain('APPLY');
  });
});
