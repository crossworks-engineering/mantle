import { describe, expect, it } from 'vitest';
import { DecisionCache } from './cache';
import { resolveUse, summarizeAnswers } from './decide';
import { applyPassageScores } from './passage-scoring';
import { delegationCriteria, delegationHintLine, wordCount } from './delegation-hint';

describe('resolveUse', () => {
  it('a use missing from params is OFF', () => {
    expect(resolveUse({}, 'passage_scoring').enabled).toBe(false);
    expect(resolveUse(null, 'passage_scoring').enabled).toBe(false);
  });

  it('an enabled use with no mode is shadow (the safe default)', () => {
    const u = resolveUse({ uses: { passage_scoring: { enabled: true } } }, 'passage_scoring');
    expect(u).toMatchObject({ enabled: true, mode: 'shadow', deferBelow: 0.6, actAloneAt: 0.9 });
  });

  it('live mode, threshold and floors read through', () => {
    const u = resolveUse(
      {
        defer_below: 0.5,
        act_alone_at: 0.95,
        uses: { passage_scoring: { enabled: true, mode: 'live', threshold: 2 } },
      },
      'passage_scoring',
    );
    expect(u).toEqual({
      enabled: true,
      mode: 'live',
      threshold: 2,
      deferBelow: 0.5,
      actAloneAt: 0.95,
    });
  });

  it('act_alone_at can never sit below defer_below', () => {
    const u = resolveUse(
      { defer_below: 0.8, act_alone_at: 0.5, uses: { model_routing: { enabled: true } } },
      'model_routing',
    );
    expect(u.actAloneAt).toBe(0.8);
  });
});

describe('summarizeAnswers', () => {
  it('compacts each answer to what was picked and how sure', () => {
    expect(
      summarizeAnswers({
        a: { type: 'noul', probability: 0.9612 },
        b: { type: 'choice', choice: 'x', confidence: 0.751, probabilities: { x: 0.8, y: 0.2 } },
        c: { type: 'score', score: 2.987, confidence: 0.99, probabilities: {} },
      }),
    ).toEqual({ a: 0.96, b: 'x@0.75', c: '2.99@0.99' });
  });
});

describe('DecisionCache', () => {
  it('evicts the least recently used entry past the cap and expires by ttl', () => {
    let now = 1_000;
    const c = new DecisionCache<number>(2, 100, () => now);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // touch a → b is now the oldest
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    now += 101;
    expect(c.get('a')).toBeUndefined();
  });

  it('keys are stable for equal inputs and differ otherwise', () => {
    expect(DecisionCache.key(['u', { a: 1 }])).toBe(DecisionCache.key(['u', { a: 1 }]));
    expect(DecisionCache.key(['u', { a: 1 }])).not.toBe(DecisionCache.key(['u', { a: 2 }]));
  });
});

describe('applyPassageScores', () => {
  const items = [
    { id: 'p1', t: 'first' },
    { id: 'p2', t: 'second' },
    { id: 'p3', t: 'third' },
    { id: 'p4', t: 'unscored' },
  ];
  const scores = new Map([
    ['p1', { score: 1.0, confidence: 0.9 }],
    ['p2', { score: 2.9, confidence: 0.9 }],
    ['p3', { score: 2.9, confidence: 0.5 }],
  ]);

  it('drops under the threshold, orders by score, keeps ties in search order, appends unscored', () => {
    const r = applyPassageScores(items, (x) => x.id, { scores, threshold: 1.5 });
    expect(r.kept.map((x) => x.id)).toEqual(['p2', 'p3', 'p4']);
    expect(r.dropped.map((x) => x.id)).toEqual(['p1']);
  });

  it('a threshold of 0 keeps everything, still reordered', () => {
    const r = applyPassageScores(items, (x) => x.id, { scores, threshold: 0 });
    expect(r.kept.map((x) => x.id)).toEqual(['p2', 'p3', 'p1', 'p4']);
    expect(r.dropped).toEqual([]);
  });
});

describe('delegation hint', () => {
  const base = {
    pick: 'pages',
    confidence: 0.84,
    probabilities: { pages: 0.84, none: 0.1 },
    mode: 'live' as const,
    deferBelow: 0.6,
    cached: false,
    ms: 300,
  };

  it('criteria: descriptions as given, remy tightened, none appended', () => {
    const c = delegationCriteria([
      { slug: 'pages', description: 'Document specialist.' },
      { slug: 'remy', description: 'Memory-recall agent.' },
      { slug: 'coder', description: null },
    ]);
    expect(Object.keys(c)).toEqual(['pages', 'remy', 'coder', 'none']);
    expect(c.pages).toBe('Document specialist.');
    expect(c.remy).toMatch(/PAST CONVERSATIONS only/);
    expect(c.coder).toMatch(/'coder' specialist/);
  });

  it('shows a line only in live mode, above the floor, and never for none', () => {
    expect(delegationHintLine(base)).toMatch(/work for `pages` \(confidence 84%\)/);
    expect(delegationHintLine({ ...base, mode: 'shadow' })).toBeNull();
    expect(delegationHintLine({ ...base, confidence: 0.55 })).toBeNull();
    expect(delegationHintLine({ ...base, pick: 'none', confidence: 0.99 })).toBeNull();
    expect(delegationHintLine(null)).toBeNull();
  });

  it('counts words', () => {
    expect(wordCount('  yes   but shorter ')).toBe(3);
    expect(wordCount('')).toBe(0);
  });
});
