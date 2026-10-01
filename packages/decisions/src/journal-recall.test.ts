import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ use: string; state: any; questions: Record<string, any> }>,
}));

vi.mock('./decide', () => ({
  DecideBatch: class {
    skipped = 0;
    note() {}
    settle() {}
  },
  decide: vi.fn(async (input: any) => {
    h.calls.push({ use: input.use, state: input.state, questions: input.questions });
    return {
      answers: Object.fromEntries(
        Object.keys(input.questions).map((k) => [
          k,
          { type: 'score', score: 2, confidence: 0.9, probabilities: {} },
        ]),
      ),
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
      ms: 200,
    };
  }),
}));

import {
  JOURNAL_RECALL_GROUP,
  JOURNAL_RECALL_THRESHOLD_DEFAULT,
  scoreJournalRules,
} from './journal-recall';

beforeEach(() => {
  h.calls.length = 0;
});

describe('scoreJournalRules', () => {
  it('scores every rule under journal_recall, in parallel groups, with the previous exchange', async () => {
    const rules = Array.from({ length: JOURNAL_RECALL_GROUP + 5 }, (_, i) => ({
      id: `n${i}`,
      text: `rule ${i}`,
    }));
    const r = await scoreJournalRules('o', 'yes, do the header next', 'USER: edit the SOP', rules);
    expect(h.calls.map((c) => Object.keys(c.questions).length)).toEqual([JOURNAL_RECALL_GROUP, 5]);
    expect(h.calls.every((c) => c.use === 'journal_recall')).toBe(true);
    expect(h.calls[0]!.state).toMatchObject({
      message: 'yes, do the header next',
      previous_exchange: 'USER: edit the SOP',
    });
    expect(h.calls[0]!.state.rules.r1).toBe('rule 0');
    expect(h.calls[0]!.questions.r1.criteria).toHaveLength(4);
    expect(r).toMatchObject({ calls: 2, failed: 0, threshold: JOURNAL_RECALL_THRESHOLD_DEFAULT });
    expect(r!.scores.get('n44')).toBe(2);
  });

  it('nothing to score = null', async () => {
    expect(await scoreJournalRules('o', 'q', null, [])).toBeNull();
    expect(h.calls).toHaveLength(0);
  });
});
