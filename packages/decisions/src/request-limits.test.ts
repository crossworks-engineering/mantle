import { describe, expect, it } from 'vitest';
import {
  CAREFUL_DECISION_LIMITS,
  decisionRequestLimits,
} from '@mantle/client-types/decision-models';
import { CHARS_PER_TOKEN, PLAN_HEADROOM, planGroups, requestOverLimit } from './request-limits';

describe('decisionRequestLimits', () => {
  it('a tested model is sized from its profile only, never from the catalog', () => {
    const none = { maxQuestions: null, maxInputTokens: null, cutAt: null, source: 'profile' };
    expect(decisionRequestLimits('~typesafe/jev-latest', null)).toEqual(none);
    expect(decisionRequestLimits('~typesafe/jev-latest', 32_768)).toEqual(none);
    expect(decisionRequestLimits('typesafe/jev-1.14', 262_144)).toEqual(none);
  });

  it('Jev keeps every use at its measured size whatever the catalog says', () => {
    // 60 version pairs of full-length passages: about 330k characters.
    const limits = decisionRequestLimits('~typesafe/jev-latest', 32_768);
    const pairs = Array.from({ length: 60 }, () => unit(5_450));
    const r = planGroups(pairs, (u) => u, { groupSize: 60, baseChars: 0, limits });
    expect(r.groups.map((g) => g.length)).toEqual([60]);
    expect(requestOverLimit(limits, { t: 'x'.repeat(330_000) }, {})).toBeNull();
  });

  it('an untested model, or one that failed at full size, gets the careful limits', () => {
    for (const id of ['someone/new-decider', 'baseten/joey-1', 'cloudflare/clairic']) {
      expect(decisionRequestLimits(id, null)).toEqual({
        maxQuestions: CAREFUL_DECISION_LIMITS.maxQuestions,
        maxInputTokens: CAREFUL_DECISION_LIMITS.maxInputTokens,
        cutAt: CAREFUL_DECISION_LIMITS.maxInputTokens,
        source: 'careful',
      });
    }
    // A smaller catalog context lowers the careful token limit.
    expect(decisionRequestLimits('someone/new-decider', 8_192).maxInputTokens).toBe(8_192);
    // A larger one does not raise it.
    expect(decisionRequestLimits('someone/new-decider', 131_072).maxInputTokens).toBe(16_384);
  });

  it('a suspected silent cut is the token limit and the cut point', () => {
    expect(decisionRequestLimits('cloudflare/clef-flash', 131_072)).toMatchObject({
      maxInputTokens: 16_384,
      cutAt: 16_384,
      source: 'profile',
    });
  });

  it('a bad catalog value is ignored', () => {
    expect(decisionRequestLimits('someone/new-decider', 0).maxInputTokens).toBe(16_384);
    expect(decisionRequestLimits('someone/new-decider', Number.NaN).maxInputTokens).toBe(16_384);
  });
});

const unit = (chars: number, questions = 1) => ({ chars, questions });
const sizes = (units: Array<{ chars: number; questions: number }>) =>
  planGroups(units, (u) => u, {
    groupSize: 25,
    baseChars: 0,
    limits: null,
  }).groups.map((g) => g.length);

describe('planGroups', () => {
  it('with no limit the units go in chunks of the use size, as always', () => {
    expect(sizes(Array.from({ length: 60 }, () => unit(3_000)))).toEqual([25, 25, 10]);
    expect(sizes(Array.from({ length: 7 }, () => unit(3_000)))).toEqual([7]);
    expect(sizes([])).toEqual([]);
  });

  it('a limit that binds spreads the units evenly over the requests it needs', () => {
    const units = Array.from({ length: 25 }, () => unit(100));
    const { groups } = planGroups(units, (u) => u, {
      groupSize: 25,
      baseChars: 0,
      limits: { maxQuestions: 16, maxInputTokens: null, cutAt: null, source: 'careful' },
    });
    expect(groups.map((g) => g.length)).toEqual([13, 12]);
  });

  it('counts questions per unit (two per rule pair)', () => {
    const units = Array.from({ length: 20 }, () => unit(100, 2));
    const { groups } = planGroups(units, (u) => u, {
      groupSize: 20,
      baseChars: 0,
      limits: { maxQuestions: 16, maxInputTokens: null, cutAt: null, source: 'careful' },
    });
    expect(groups.map((g) => g.length)).toEqual([7, 7, 6]);
    for (const g of groups) expect(g.length * 2).toBeLessThanOrEqual(16);
  });

  it('keeps every request under the token budget, base state included', () => {
    const limits = {
      maxQuestions: null,
      maxInputTokens: 16_384,
      cutAt: 16_384,
      source: 'careful',
    } as const;
    const budget = Math.floor(16_384 * PLAN_HEADROOM) * CHARS_PER_TOKEN;
    const units = Array.from({ length: 25 }, () => unit(3_000));
    const { groups, refused } = planGroups(units, (u) => u, {
      groupSize: 25,
      baseChars: 1_000,
      limits,
    });
    expect(refused).toEqual([]);
    expect(groups.length).toBeGreaterThan(1);
    for (const g of groups) expect(1_000 + g.length * 3_000).toBeLessThanOrEqual(budget);
    expect(groups.flat()).toHaveLength(25);
  });

  it('refuses a unit too large for any request, and every unit when the base is', () => {
    const limits = {
      maxQuestions: 16,
      maxInputTokens: 1_000,
      cutAt: 1_000,
      source: 'careful',
    } as const;
    const big = unit(10_000);
    const small = unit(100);
    const r = planGroups([small, big, small], (u) => u, { groupSize: 25, baseChars: 0, limits });
    expect(r.refused).toEqual([big]);
    expect(r.groups).toEqual([[small, small]]);
    const none = planGroups([small], (u) => u, { groupSize: 25, baseChars: 5_000, limits });
    expect(none).toEqual({ groups: [], refused: [small] });
  });
});

describe('requestOverLimit', () => {
  const q = { type: 'noul', instructions: 'x' } as const;
  it('names the question limit and the token limit', () => {
    const limits = { maxQuestions: 1, maxInputTokens: 100, cutAt: 100, source: 'careful' } as const;
    expect(requestOverLimit(limits, {}, { a: q })).toBeNull();
    expect(requestOverLimit(limits, {}, { a: q, b: q })?.reason).toMatch(/2 questions/);
    expect(requestOverLimit(limits, { t: 'x'.repeat(1_000) }, { a: q })?.reason).toMatch(
      /input tokens/,
    );
  });

  it('no known limit: nothing is refused', () => {
    const none = {
      maxQuestions: null,
      maxInputTokens: null,
      cutAt: null,
      source: 'profile',
    } as const;
    expect(requestOverLimit(none, { t: 'x'.repeat(1_000_000) }, { a: q })).toBeNull();
  });
});
