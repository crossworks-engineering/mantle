import { describe, expect, it } from 'vitest';
import {
  VERSION_SIMILARITY_FLOOR,
  applyVersionGroups,
  candidateVersionPairs,
  dropSupersededInPool,
  versionQuestion,
  type VersionPassage,
} from './version-grouping';

describe('dropSupersededInPool (part A, code)', () => {
  it('drops a stale hit only when its living successor is in the pool', () => {
    const hits = [
      { nodeId: 'new', text: 'current' },
      { nodeId: 'old', text: 'stale', supersededBy: { id: 'new' } },
      {
        nodeId: 'orphan',
        text: 'stale, successor not retrieved',
        supersededBy: { id: 'elsewhere' },
      },
    ];
    const r = dropSupersededInPool(hits);
    expect(r.dropped.map((h) => h.nodeId)).toEqual(['old']);
    expect(r.kept.map((h) => h.nodeId)).toEqual(['new', 'orphan']);
  });

  it('keeps the successor wherever it ranked, even below the stale hit', () => {
    const r = dropSupersededInPool([
      { nodeId: 'old', supersededBy: { id: 'new' } },
      { nodeId: 'x' },
      { nodeId: 'new' },
    ]);
    expect(r.kept.map((h) => h.nodeId)).toEqual(['x', 'new']);
  });
});

const p = (id: string, nodeId: string, supersededBy?: string): VersionPassage => ({
  id,
  nodeId,
  title: nodeId,
  text: id,
  ...(supersededBy ? { supersededBy: { id: supersededBy } } : {}),
});

describe('candidateVersionPairs (part B filter)', () => {
  const passages = [p('a:0', 'A'), p('a:1', 'A'), p('b:0', 'B'), p('c:0', 'C', 'B')];

  it('skips same-node pairs, linked pairs and weak similarity; most similar first', () => {
    const pairs = candidateVersionPairs(passages, [
      { a: 'a:0', b: 'a:1', similarity: 0.99 }, // same node
      { a: 'b:0', b: 'c:0', similarity: 0.98 }, // linked by supersession: code's job
      { a: 'a:0', b: 'b:0', similarity: 0.8 },
      { a: 'a:1', b: 'b:0', similarity: 0.9 },
      { a: 'a:0', b: 'c:0', similarity: VERSION_SIMILARITY_FLOOR - 0.01 },
    ]);
    expect(pairs.map((x) => `${x.a}~${x.b}`)).toEqual(['a:1~b:0', 'a:0~b:0']);
  });

  it('caps the number of questions', () => {
    const many = Array.from({ length: 10 }, (_, i) => p(`n${i}:0`, `N${i}`));
    const sims = [];
    for (let i = 0; i < 10; i++)
      for (let j = i + 1; j < 10; j++) sims.push({ a: `n${i}:0`, b: `n${j}:0`, similarity: 0.9 });
    expect(candidateVersionPairs(many, sims, 0.75, 5)).toHaveLength(5);
  });
});

describe('applyVersionGroups', () => {
  const id = (x: string) => x;

  it('drops the lower-ranked passage of a yes pair at the threshold', () => {
    const r = applyVersionGroups(['top', 'mid', 'copy'], id, {
      threshold: 0.9,
      pairs: [
        { a: 'copy', b: 'top', probability: 0.95 },
        { a: 'mid', b: 'top', probability: 0.89 },
      ],
    });
    expect(r.kept).toEqual(['top', 'mid']);
    expect(r.dropped).toEqual(['copy']);
  });

  it('never chains: a dropped passage does not cause another drop', () => {
    // A~B yes, B~C yes, A~C not asked. B goes (twin of A); C has no kept twin.
    const r = applyVersionGroups(['A', 'B', 'C'], id, {
      threshold: 0.9,
      pairs: [
        { a: 'A', b: 'B', probability: 0.97 },
        { a: 'B', b: 'C', probability: 0.97 },
      ],
    });
    expect(r.kept).toEqual(['A', 'C']);
    expect(r.dropped).toEqual(['B']);
  });

  it('keeps everything when no answer reaches the threshold', () => {
    const r = applyVersionGroups(['A', 'B'], id, {
      threshold: 0.9,
      pairs: [{ a: 'A', b: 'B', probability: 0.6 }],
    });
    expect(r.dropped).toEqual([]);
  });
});

describe('versionQuestion', () => {
  it('is a noul with the contrastive criteria from the spike', () => {
    const q = versionQuestion('passages.p1', 'passages.p2');
    expect(q.type).toBe('noul');
    expect(q.instructions).toContain('`passages.p1`');
    expect(q.type === 'noul' && q.criteria?.false).toMatch(/only share a topic/);
  });
});
