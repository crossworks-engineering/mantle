import { describe, expect, it } from 'vitest';
import { ContextTraceBuilder, armFields, armOf, judgeWhy } from './trace';

describe('decision trace builder', () => {
  it('reads the arm off the ranks', () => {
    expect(armOf(undefined)).toBe('vector');
    expect(armOf({ vr: 3 })).toBe('vector');
    expect(armOf({ kr: 1 })).toBe('keyword');
    expect(armOf({ vr: 2, kr: 1 })).toBe('both');
    expect(armFields({ kr: 1, rescued: true })).toEqual({ arm: 'keyword', kr: 1, rescued: true });
  });

  it('a live drop sets the outcome; a shadow drop only records the verdict', () => {
    const t = new ContextTraceBuilder();
    t.add({ b: 'chunk', k: 'n1:0', out: 'kept', at: 'search', why: 'sent', d: 0.123456 });
    t.add({ b: 'chunk', k: 'n2:0', out: 'kept', at: 'search', why: 'sent' });
    t.drop('chunk', 'n1:0', 'pruning', judgeWhy(1), 'live');
    t.drop('chunk', 'n2:0', 'pruning', judgeWhy(1), 'shadow');
    t.score('chunk', 'n2:0', 0.4567);
    const rows = t.toJSON().rows;
    expect(rows).toContainEqual({
      b: 'chunk',
      k: 'n1:0',
      out: 'dropped',
      at: 'pruning',
      why: 'judge:<1',
      d: 0.123,
    });
    expect(rows).toContainEqual({
      b: 'chunk',
      k: 'n2:0',
      out: 'kept',
      at: 'search',
      why: 'sent',
      s: 0.46,
      would: 'judge:<1',
    });
  });

  it('the first decision stands: a later stage cannot re-drop or invent a row', () => {
    const t = new ContextTraceBuilder();
    t.add({ b: 'fact', k: 'f1', out: 'kept', at: 'facts', why: 'sent' });
    t.drop('fact', 'f1', 'pruning', 'judge:<1');
    t.drop('fact', 'f1', 'journal', 'dedupe:journal');
    t.drop('fact', 'nope', 'journal', 'dedupe:journal');
    t.add({ b: 'fact', k: 'f1', out: 'kept', at: 'facts', why: 'sent' });
    expect(t.toJSON().rows).toEqual([
      { b: 'fact', k: 'f1', out: 'dropped', at: 'pruning', why: 'judge:<1' },
    ]);
  });

  it('keeps rd only when it differs from d', () => {
    const t = new ContextTraceBuilder();
    t.add({ b: 'hit', k: 'a', out: 'kept', at: 'hits', why: 'sent', d: 0.3, rd: 0.3 });
    t.add({ b: 'hit', k: 'b', out: 'kept', at: 'hits', why: 'sent', d: 0.3, rd: 0.3512 });
    const [a, b] = t.toJSON().rows;
    expect(a).not.toHaveProperty('rd');
    expect(b!.rd).toBe(0.351);
  });

  it('caps the rows with kept rows first and counts the rest', () => {
    const t = new ContextTraceBuilder();
    for (let i = 0; i < 10; i++) {
      t.add({ b: 'chunk', k: `d${i}`, out: 'dropped', at: 'select', why: 'limit:8' });
    }
    t.add({ b: 'chunk', k: 'k1', out: 'kept', at: 'search', why: 'sent' });
    const j = t.toJSON(4);
    expect(j.rows.map((r) => r.k)).toEqual(['k1', 'd0', 'd1', 'd2']);
    expect(j.more).toBe(7);
  });

  it('a full trace stays small', () => {
    const t = new ContextTraceBuilder();
    for (let i = 0; i < 250; i++) {
      t.add({
        b: 'chunk',
        k: `0f8fad5b-d9cb-469f-a165-70867728950e:${i}`,
        out: i < 8 ? 'kept' : 'dropped',
        at: 'select',
        why: i < 8 ? 'sent' : 'limit:8',
        arm: 'both',
        rank: i + 1,
        vr: i + 1,
        kr: i + 2,
        d: 0.41234,
        s: 2.5,
      });
    }
    const j = t.toJSON();
    expect(j.rows).toHaveLength(150);
    expect(j.more).toBe(100);
    // Far under the 64 KB trace step ceiling, with room for the snapshot.
    expect(JSON.stringify(j).length).toBeLessThan(32_000);
  });
});
