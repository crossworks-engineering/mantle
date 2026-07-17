import { describe, expect, it } from 'vitest';
import { terminalSuccessors } from './supersede';

/** Pure half of successor resolution (the DB wrapper batches edge loads and is
 *  verified live, house style). The walk must land on the LIVING end of a
 *  chain — annotating a hit with an intermediate (itself-superseded) node
 *  would send the model to another stale document. */

const edges = (pairs: Array<[string, string]>) => new Map(pairs);

describe('terminalSuccessors', () => {
  it('returns nothing for unsuperseded ids', () => {
    expect(terminalSuccessors(edges([]), ['a', 'b']).size).toBe(0);
  });

  it('resolves a direct successor (1 hop)', () => {
    const out = terminalSuccessors(edges([['a', 'b']]), ['a']);
    expect(out.get('a')).toEqual({ id: 'b', hops: 1 });
  });

  it('walks to the living END of a chain, not the immediate successor', () => {
    // v01 → v02 → page: a hit on v01 must point at the page.
    const out = terminalSuccessors(
      edges([
        ['v01', 'v02'],
        ['v02', 'page'],
      ]),
      ['v01', 'v02'],
    );
    expect(out.get('v01')).toEqual({ id: 'page', hops: 2 });
    expect(out.get('v02')).toEqual({ id: 'page', hops: 1 });
  });

  it('caps a pathological over-long chain instead of looping', () => {
    const long = edges([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'e'],
      ['e', 'f'],
      ['f', 'g'],
      ['g', 'h'],
    ]);
    const out = terminalSuccessors(long, ['a'], 5);
    // 5 hops from a: b,c,d,e,f — stops there rather than walking forever.
    expect(out.get('a')).toEqual({ id: 'f', hops: 5 });
  });

  it('survives a malformed cycle (unwritable via the guard, but hand-edited data must not hang)', () => {
    const cycle = edges([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    const out = terminalSuccessors(cycle, ['a'], 5);
    expect(out.get('a')?.hops).toBe(5); // cap hit, no infinite loop
  });

  it('resolves multiple independent families in one call', () => {
    const out = terminalSuccessors(
      edges([
        ['x1', 'x2'],
        ['y1', 'y2'],
      ]),
      ['x1', 'y1', 'z'],
    );
    expect(out.get('x1')?.id).toBe('x2');
    expect(out.get('y1')?.id).toBe('y2');
    expect(out.has('z')).toBe(false);
  });
});
