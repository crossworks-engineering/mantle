import { describe, expect, it } from 'vitest';
import { RANK_RE } from '../rank';
import { RANK_MAX_LEN, planWhole, rankAt, type OrderRow } from './order-plan';

const row = (id: string, rank: string | null, copy = false): OrderRow => ({ id, rank, copy });
const all = () => true;

/** The ids in the order their ranks put them (the plan applied to rows). */
function orderAfter(rows: readonly OrderRow[], writes: ReturnType<typeof planWhole>): string[] {
  const rank = new Map(rows.map((r) => [r.id, r.rank]));
  for (const w of writes) rank.set(w.id, w.rank);
  return [...rank]
    .filter(([, r]) => r !== null)
    .sort(([, a], [, b]) => (a! < b! ? -1 : a! > b! ? 1 : 0))
    .map(([id]) => id);
}

describe('rankAt: one row between its neighbours', () => {
  it('goes between two ranked neighbours, and at either end', () => {
    const rows = [row('a', 'c'), row('b', 'm')];
    const mid = rankAt(rows, 1)!;
    expect(mid > 'c' && mid < 'm').toBe(true);
    expect(rankAt(rows, 0)! < 'c').toBe(true);
    expect(rankAt(rows, 2)! > 'm').toBe(true);
    expect(rankAt([], 0)).toBe('i');
  });

  it('leaves a copy out: its rank bounds nothing and never ties', () => {
    // The copy inherited a's rank: it sits beside a, and the place after a
    // still goes between a and b, writing one row.
    const rows = [row('a', 'c'), row('copy', 'c', true), row('b', 'm')];
    const r = rankAt(rows, 1)!;
    expect(r > 'c' && r < 'm').toBe(true);
    expect(rankAt(rows, 2)).toBe(r);
    // A copy with no rank is no neighbour either.
    expect(rankAt([row('a', 'c'), row('copy', null, true)], 2)! > 'c').toBe(true);
  });

  it('has no room beside an unranked neighbour, a tie, or a key grown long', () => {
    expect(rankAt([row('a', 'c'), row('b', null)], 1)).toBeNull();
    expect(rankAt([row('a', null), row('b', 'm')], 1)).toBeNull();
    expect(rankAt([row('a', 'm'), row('b', 'm')], 1)).toBeNull();
    const long = 'i'.repeat(RANK_MAX_LEN);
    expect(rankAt([row('a', long), row('b', `${long}1`)], 1)).toBeNull();
  });
});

describe('planWhole: a place that needs the folder ranked', () => {
  it('ranks an unordered folder whole, evenly, in the order shown', () => {
    const rows = [row('a', null), row('b', null), row('c', null)];
    const w = planWhole(rows, 1, 'x', false, all);
    expect(w.map((x) => x.id)).toEqual(['a', 'x', 'b', 'c']);
    expect(w.every((x) => RANK_RE.test(x.rank))).toBe(true);
    expect(orderAfter(rows, w)).toEqual(['a', 'x', 'b', 'c']);
  });

  it('in an ordered folder keeps every rank: only the unranked take one, after the last', () => {
    // h is a row the caller does not see: it is not in rows, and its rank
    // 'e' must keep it between a ('c') and b ('g').
    const rows = [row('a', 'c'), row('b', 'g'), row('n1', null), row('n2', null)];
    const w = planWhole(rows, 3, 'x', true, all);
    const by = new Map(w.map((x) => [x.id, x.rank]));
    expect(by.has('a')).toBe(false);
    expect(by.has('b')).toBe(false);
    expect([...by.keys()].sort()).toEqual(['n1', 'n2', 'x']);
    expect(by.get('n1')! > 'g').toBe(true);
    expect(by.get('n1')! < by.get('x')!).toBe(true);
    expect(by.get('x')! < by.get('n2')!).toBe(true);
    expect(orderAfter([...rows, row('h', 'e')], w)).toEqual(['a', 'h', 'b', 'n1', 'x', 'n2']);
  });

  it('stays short however many rows wait for a rank', () => {
    const rows = [row('a', 'c'), ...Array.from({ length: 4000 }, (_, i) => row(`n${i}`, null))];
    const w = planWhole(rows, rows.length, 'x', true, all);
    expect(w).toHaveLength(4001);
    expect(Math.max(...w.map((x) => x.rank.length))).toBeLessThanOrEqual(5);
    expect(w.every((x) => RANK_RE.test(x.rank))).toBe(true);
    expect(orderAfter(rows, w).at(-1)).toBe('x');
  });

  it('ranks whole when the folder is ordered and still has no room (a tie)', () => {
    const rows = [row('a', 'm'), row('b', 'm')];
    const w = planWhole(rows, 1, 'x', true, all);
    expect(w.map((x) => x.id)).toEqual(['a', 'x', 'b']);
    expect(new Set(w.map((x) => x.rank)).size).toBe(3);
  });

  it('never ranks a copy, nor a row the caller may not write', () => {
    const rows = [row('a', null), row('copy', null, true), row('b', null), row('locked', null)];
    const w = planWhole(rows, 0, 'x', false, (id) => id !== 'locked');
    expect(w.map((x) => x.id)).toEqual(['x', 'a', 'b']);
    const ordered = planWhole(
      [row('a', 'c'), row('locked', null)],
      2,
      'x',
      true,
      (id) => id !== 'locked',
    );
    expect(ordered.map((x) => x.id)).not.toContain('locked');
    expect(ordered.map((x) => x.id)).toContain('x');
  });
});
