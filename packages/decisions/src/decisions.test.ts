import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './breaker';
import { DecisionCache } from './cache';
import { resolveUse, summarizeAnswers } from './decide';
import { applyPassageScores } from './passage-scoring';
import {
  delegationCriteria,
  delegationHintLine,
  delegationHintTraceData,
  splitOnScreenNote,
  wordCount,
} from './delegation-hint';
import { pruneContextItems } from './context-pruning';

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

describe('CircuitBreaker', () => {
  it('opens after the threshold of failures in a row, probes once after the cooldown', () => {
    let now = 0;
    const b = new CircuitBreaker(3, 100, () => now);
    expect(b.failure('w')).toBe(false);
    expect(b.failure('w')).toBe(false);
    expect(b.allow('w')).toBe(true);
    expect(b.failure('w')).toBe(true); // this one opened it
    expect(b.allow('w')).toBe(false);
    now = 99;
    expect(b.allow('w')).toBe(false);
    now = 100;
    expect(b.allow('w')).toBe(true); // the probe
    expect(b.allow('w')).toBe(false); // the rest wait out the re-armed cooldown
    expect(b.failure('w')).toBe(false); // failed probe: still open, not "opened"
    now = 150;
    expect(b.allow('w')).toBe(false);
    now = 200;
    expect(b.allow('w')).toBe(true);
    expect(b.success('w')).toBe(true); // closed
    expect(b.allow('w')).toBe(true);
    expect(b.isOpen('w')).toBe(false);
  });

  it('a success resets the count; keys are independent', () => {
    const b = new CircuitBreaker(2, 100, () => 0);
    b.failure('w');
    expect(b.success('w')).toBe(false);
    b.failure('w');
    expect(b.isOpen('w')).toBe(false);
    b.failure('x');
    b.failure('x');
    expect(b.isOpen('x')).toBe(true);
    expect(b.allow('w')).toBe(true);
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
    surface: 'page',
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

  it('none covers page and table edits (the responder does them), not app work', () => {
    // Spike v2 (NATREF, 130 turns): the responder edits pages and tables itself
    // since 2026-08-12 but still hands app work to its specialist.
    const c = delegationCriteria([{ slug: 'pages', description: 'Document specialist.' }]);
    expect(c.none).toMatch(/an edit to a page or table, including the one in `open_surface`/);
    expect(c.none).toMatch(/Not for a large job .*work inside an app/);
  });

  it('traces the surface kind next to the pick', () => {
    expect(delegationHintTraceData(base)).toMatchObject({ pick: 'pages', surface: 'page' });
  });
});

describe('splitOnScreenNote', () => {
  // The exact shape jackdaw's buildContextPreamble appends.
  const note = (item: string) =>
    '\n\n---\nOn screen right now — the user has this open in the editor and means it by "this page" (if a specialist does the work, hand it the node id and any focus directive verbatim):\n' +
    item;

  it('splits typed text from the open page', () => {
    const r = splitOnScreenNote(
      'please update the header' +
        note('- page "Line Class SOP" (node 4516836f-91e2-4bcb-8630-3e817869c995)'),
    );
    expect(r).toEqual({
      typed: 'please update the header',
      openSurface: { kind: 'page', title: 'Line Class SOP' },
    });
  });

  it('maps the note nouns back to kind ids, and keeps meta out of the title', () => {
    const r = splitOnScreenNote(
      'tidy this up' + note('- journal entry "Tuesday" (node abc) [tab: body]'),
    );
    expect(r.openSurface).toEqual({ kind: 'journal', title: 'Tuesday' });
    expect(splitOnScreenNote('x' + note('- drawing "Pump" (node abc)')).openSurface?.kind).toBe(
      'draw',
    );
    expect(splitOnScreenNote('x' + note('- email "Re: bid" (email id 42)')).openSurface).toEqual({
      kind: 'email',
      title: 'Re: bid',
    });
  });

  it('attached context alone is not an open surface', () => {
    const r = splitOnScreenNote(
      'compare these\n\n---\nAttached context (read these with your tools as needed):\n- file "a.pdf" (node x)',
    );
    expect(r).toEqual({ typed: 'compare these', openSurface: null });
  });

  it('a FOCUS SET directive is cut from the typed text too', () => {
    expect(splitOnScreenNote('make it bold\nFOCUS SET — lines 3-5').typed).toBe('make it bold');
  });

  it('no note: all typed, no surface', () => {
    expect(splitOnScreenNote('  what is the status of the Forge plan?  ')).toEqual({
      typed: 'what is the status of the Forge plan?',
      openSurface: null,
    });
  });
});

describe('pruneContextItems', () => {
  type It = { id: string; pref?: boolean };
  const items: It[] = [
    { id: 'pref', pref: true },
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' },
    { id: 'late' }, // past the request cap: unscored
  ];
  const scores = new Map([
    ['a', { score: 0.4, confidence: 0.9 }],
    ['b', { score: 2.1, confidence: 0.9 }],
    ['c', { score: 1.0, confidence: 0.9 }],
    ['d', { score: 0.2, confidence: 0.9 }],
  ]);
  const idOf = (x: It) => x.id;
  const exempt = (x: It) => !!x.pref;

  it('keeps exempt first, then scored ≥ threshold best-first, then unscored; drops the rest', () => {
    const r = pruneContextItems(items, idOf, { scores, threshold: 1.0 }, { exempt });
    expect(r.kept.map(idOf)).toEqual(['pref', 'b', 'c', 'late']);
    expect(r.dropped.map(idOf)).toEqual(['a', 'd']);
  });

  it('a floor keeps the best of the cut', () => {
    const r = pruneContextItems(items, idOf, { scores, threshold: 3 }, { exempt, floor: 2 });
    expect(r.kept.map(idOf)).toEqual(['pref', 'b', 'c', 'late']);
    expect(r.dropped.map(idOf)).toEqual(['a', 'd']);
  });

  it('a floor larger than the scored set keeps everything scored', () => {
    const r = pruneContextItems(items, idOf, { scores, threshold: 3 }, { floor: 10 });
    expect(r.dropped).toEqual([]);
  });

  it('threshold 0 keeps all, reordered by score', () => {
    const r = pruneContextItems(items, idOf, { scores, threshold: 0 }, { exempt });
    expect(r.kept.map(idOf)).toEqual(['pref', 'b', 'c', 'a', 'd', 'late']);
  });
});
