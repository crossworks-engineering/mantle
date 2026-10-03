import { describe, expect, it } from 'vitest';
import {
  comparePaired,
  gateFailures,
  goldRankOf,
  parseRouteCases,
  percentile,
  summarizeByType,
  type CaseResult,
} from './route-score';

const res = (id: string, type: CaseResult['type'], rank: number | null, ms = 10): CaseResult => ({
  id,
  type,
  profile: 'library',
  rank,
  ms,
  usd: 0,
});

describe('eval:route scoring', () => {
  it('validates typed cases', () => {
    const ok = parseRouteCases([
      { id: 'a', query: 'q', type: 'T3', flags: ['T2'], expectNodeIds: ['n'] },
    ]);
    expect(ok[0]).toMatchObject({ type: 'T3', flags: ['T2'] });
    expect(() =>
      parseRouteCases([{ id: 'a', query: 'q', type: 'T9', expectNodeIds: ['n'] }]),
    ).toThrow(/type/);
    expect(() => parseRouteCases([{ id: 'a', query: 'q', type: 'T2' }])).toThrow(/needs/);
    expect(() =>
      parseRouteCases([
        { id: 'a', query: 'q', type: 'T2', expectNodeIds: ['n'] },
        { id: 'a', query: 'r', type: 'T2', expectNodeIds: ['n'] },
      ]),
    ).toThrow(/duplicate/);
  });

  it('ranks passage gold by node and ordinal, else document gold by id or title', () => {
    const hits = [
      { nodeId: 'n1', title: 'Other', ordinal: 3 },
      { nodeId: 'n2', title: 'The Tender Spec', ordinal: 7 },
      { nodeId: 'n2', title: 'The Tender Spec', ordinal: 8 },
    ];
    const base = { id: 'x', query: 'q', type: 'T2' as const };
    expect(goldRankOf({ ...base, expectChunks: [{ nodeId: 'n2', ordinals: [8] }] }, hits)).toBe(3);
    expect(
      goldRankOf({ ...base, expectChunks: [{ nodeId: 'n2', ordinals: [1] }] }, hits),
    ).toBeNull();
    expect(goldRankOf({ ...base, expectNodeIds: ['n2'] }, hits)).toBe(2);
    expect(goldRankOf({ ...base, expectNodeTitleIncludes: ['tender'] }, hits)).toBe(2);
  });

  it('summarizes per type in plan order, plus all', () => {
    const rows = summarizeByType(
      [res('a', 'T6', 1, 5), res('b', 'T6', 4, 7), res('c', 'T2', null, 9), res('d', 'T2', 12)],
      10,
    );
    expect(rows.map((r) => r.type)).toEqual(['T2', 'T6', 'all']);
    expect(rows[1]).toMatchObject({ n: 2, r1: 0.5, rk: 1, mrr: 0.625, p50: 5, p90: 7 });
    expect(rows[0]).toMatchObject({ n: 2, r1: 0, rk: 0, mrr: 0.042 });
    expect(rows[2]).toMatchObject({ n: 4, r1: 0.25, rk: 0.5 });
  });

  it('nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([30, 10, 20], 50)).toBe(20);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it('pairs cases by id and gates on per-type losses', () => {
    const ref = [res('a', 'T3', null), res('b', 'T3', 2), res('c', 'T6', 1), res('d', 'T6', 3)];
    const cand = [res('a', 'T3', 1), res('b', 'T3', 1), res('c', 'T6', null), res('d', 'T6', 3)];
    const d = comparePaired(ref, cand, 10);
    expect(d.find((x) => x.type === 'T3')).toMatchObject({ wonK: 1, lostK: 0, won1: 2, lost1: 0 });
    expect(d.find((x) => x.type === 'T6')).toMatchObject({ wonK: 0, lostK: 1, lost1: 1 });
    expect(gateFailures(d)).toEqual([]);
    expect(gateFailures(d, { maxLoss: 0 })).toEqual([
      'T6 lost 1 cases at R@k (limit 0)',
      'T6 lost 1 cases at R@1 (limit 0)',
    ]);
    expect(gateFailures(d, { target: 'T6' })).toEqual(['target T6 did not gain']);
    expect(gateFailures(comparePaired(ref, ref, 10))).toEqual(['no type gained']);
  });

  it('an R@1 gain passes the gate when R@k is at the ceiling', () => {
    const ref = [res('a', 'T3', 2), res('b', 'T3', 3)];
    const cand = [res('a', 'T3', 1), res('b', 'T3', 3)];
    expect(gateFailures(comparePaired(ref, cand, 10), { target: 'T3' })).toEqual([]);
  });
});
