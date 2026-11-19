import { describe, expect, it } from 'vitest';
import { goldRank, parseEvalCases, scoreRanks } from './eval';

const hit = (id: string) => ({ id });

describe('parseEvalCases', () => {
  it('accepts both expectTitleIncludes and the eval-recall.ts field name', () => {
    const cases = parseEvalCases([
      { id: 'a', query: 'q1', expectNodeIds: ['x'] },
      { query: 'q2', expectNodeTitleIncludes: ['Acme'] },
    ]);
    expect(cases[0]).toMatchObject({ id: 'a', expectNodeIds: ['x'] });
    expect(cases[1]).toMatchObject({ id: 'case-2', expectTitleIncludes: ['Acme'] });
  });
  it('rejects a case with no query or no gold', () => {
    expect(() => parseEvalCases([{ query: '', expectNodeIds: ['x'] }])).toThrow(/query/);
    expect(() => parseEvalCases([{ query: 'q' }])).toThrow(/expectNodeIds/);
    expect(() => parseEvalCases({})).toThrow(/array/);
  });
  it('accepts stable keys as eval-recall --keys writes them', () => {
    const [c] = parseEvalCases([
      {
        id: 'k',
        query: 'q',
        expect: [
          { id: 'old-id', type: 'page', titleKey: 'aa11', bodyKey: null },
          { type: 'note', bodyKey: 'bb22' },
        ],
      },
    ]);
    expect(c!.expect).toEqual([
      { type: 'page', titleKey: 'aa11', bodyKey: null },
      { type: 'note', titleKey: null, bodyKey: 'bb22' },
    ]);
  });
  it('drops a key with no type or no hash, and a case left with no gold is refused', () => {
    expect(() =>
      parseEvalCases([{ query: 'q', expect: [{ titleKey: 'aa11' }, { type: 'page' }] }]),
    ).toThrow(/needs "expect"/);
  });
});

describe('goldRank', () => {
  const gold = new Set(['g', 'h']);
  it('ranks the first hit in the gold set', () => {
    expect(goldRank(gold, [hit('a'), hit('h'), hit('g')])).toBe(2);
  });
  it('null when gold never appears', () => {
    expect(goldRank(gold, [hit('a'), hit('b')])).toBeNull();
  });
});

describe('scoreRanks', () => {
  it('computes recall@k and MRR', () => {
    // ranks: 1, 4, null → R@1 1/3, R@3 1/3, R@5 2/3, MRR (1 + 0.25 + 0)/3
    const s = scoreRanks([1, 4, null]);
    expect(s.cases).toBe(3);
    expect(s.recallAt1).toBeCloseTo(1 / 3, 3);
    expect(s.recallAt3).toBeCloseTo(1 / 3, 3);
    expect(s.recallAt5).toBeCloseTo(2 / 3, 3);
    expect(s.recallAt10).toBeCloseTo(2 / 3, 3);
    expect(s.mrr).toBeCloseTo((1 + 0.25) / 3, 3);
  });
  it('empty set scores zero, not NaN', () => {
    expect(scoreRanks([])).toMatchObject({ cases: 0, mrr: 0, recallAt5: 0 });
  });
});
