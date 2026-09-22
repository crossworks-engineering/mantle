import { describe, expect, it } from 'vitest';
import {
  FACT_RELATION_CRITERIA,
  factRelationQuestion,
  shouldSkipClassifier,
} from './fact-add-prefilter';

describe('shouldSkipClassifier (the one rule)', () => {
  it('skips the chat classifier only for ADD at or above the gate', () => {
    expect(shouldSkipClassifier('add', 0.9, 0.9)).toBe(true);
    expect(shouldSkipClassifier('add', 0.97, 0.9)).toBe(true);
    expect(shouldSkipClassifier('add', 0.89, 0.9)).toBe(false);
  });

  it('never acts on update / delete / noop, however confident', () => {
    // Spike 1: a wrong UPDATE at 0.99. Confidence does not make these safe.
    for (const pick of ['update', 'delete', 'noop'] as const) {
      expect(shouldSkipClassifier(pick, 0.99, 0.9)).toBe(false);
      expect(shouldSkipClassifier(pick, 1, 0)).toBe(false);
    }
  });
});

describe('factRelationQuestion', () => {
  it('is a four-way choice with contrastive criteria', () => {
    const q = factRelationQuestion();
    expect(q.type).toBe('choice');
    expect(q.type === 'choice' && Object.keys(q.criteria).sort()).toEqual([
      'add',
      'delete',
      'noop',
      'update',
    ]);
  });

  it('spells out the multi-valued case the spike tripped on', () => {
    expect(FACT_RELATION_CRITERIA.add).toMatch(/many values/);
    expect(FACT_RELATION_CRITERIA.update).toMatch(/Not for an attribute that can hold many values/);
  });
});
