import { describe, it, expect } from 'vitest';
import {
  CONVERSATIONAL_ROLES,
  pickFallbackResponder,
  rankActiveAgents,
  type FallbackCandidate,
} from './agent-select';

/**
 * Inbound fallback + reflector activity gate (docs/comms-channels.md §6). These
 * pin the role-decoupled resolution the Telegram path + reflector rely on after
 * their DB fetches — the heart of the Phase 1-4 refactor.
 */
const a = (over: Partial<FallbackCandidate>): FallbackCandidate => ({
  slug: 'x',
  role: 'responder',
  priority: 100,
  enabled: true,
  ...over,
});

describe('pickFallbackResponder', () => {
  it('returns null when there are no candidates', () => {
    expect(pickFallbackResponder([])).toBeNull();
  });

  it('NEVER picks a background worker (extractor/summarizer/reflector)', () => {
    const rows = [
      a({ slug: 'extractor', role: 'extractor', priority: 999 }),
      a({ slug: 'summarizer', role: 'summarizer', priority: 998 }),
      a({ slug: 'reflector', role: 'reflector', priority: 997 }),
      a({ slug: 'saskia', role: 'responder', priority: 1 }),
    ];
    // Workers outrank on priority but are excluded by role — the guard that
    // keeps an inbound message off a non-conversational agent.
    expect(pickFallbackResponder(rows)?.slug).toBe('saskia');
  });

  it('returns null when only background workers exist', () => {
    const rows = [a({ slug: 'extractor', role: 'extractor' })];
    expect(pickFallbackResponder(rows)).toBeNull();
  });

  it('skips disabled agents', () => {
    const rows = [
      a({ slug: 'top', role: 'assistant', priority: 500, enabled: false }),
      a({ slug: 'live', role: 'responder', priority: 10, enabled: true }),
    ];
    expect(pickFallbackResponder(rows)?.slug).toBe('live');
  });

  it('treats a missing enabled flag as enabled', () => {
    const rows = [{ slug: 'a', role: 'custom', priority: 5 }];
    expect(pickFallbackResponder(rows)?.slug).toBe('a');
  });

  it('picks highest priority, then slug for a deterministic tie', () => {
    const rows = [
      a({ slug: 'zeta', priority: 100 }),
      a({ slug: 'alpha', priority: 100 }),
      a({ slug: 'low', priority: 1 }),
    ];
    expect(pickFallbackResponder(rows)?.slug).toBe('alpha');
    expect(pickFallbackResponder([...rows].reverse())?.slug).toBe('alpha');
  });

  it('accepts every conversational role', () => {
    for (const role of CONVERSATIONAL_ROLES) {
      expect(pickFallbackResponder([a({ slug: 's', role })])?.slug).toBe('s');
    }
  });
});

describe('rankActiveAgents', () => {
  const agent = (id: string, slug: string) => ({ id, slug });

  it('drops agents with zero / missing activity', () => {
    const cands = [agent('1', 'a'), agent('2', 'b'), agent('3', 'c')];
    const activity = new Map([
      ['1', 3],
      ['2', 0],
    ]); // '3' absent
    expect(rankActiveAgents(cands, activity).map((c) => c.id)).toEqual(['1']);
  });

  it('orders most-active first', () => {
    const cands = [agent('1', 'a'), agent('2', 'b'), agent('3', 'c')];
    const activity = new Map([
      ['1', 2],
      ['2', 9],
      ['3', 5],
    ]);
    expect(rankActiveAgents(cands, activity).map((c) => c.id)).toEqual(['2', '3', '1']);
  });

  it('breaks an equal-activity tie by slug (deterministic at the cap boundary)', () => {
    const cands = [agent('1', 'zeta'), agent('2', 'alpha')];
    const activity = new Map([
      ['1', 4],
      ['2', 4],
    ]);
    expect(rankActiveAgents(cands, activity).map((c) => c.slug)).toEqual(['alpha', 'zeta']);
  });

  it('returns an empty array when nothing has activity', () => {
    expect(rankActiveAgents([agent('1', 'a')], new Map())).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const cands = [agent('1', 'a'), agent('2', 'b')];
    rankActiveAgents(cands, new Map([['2', 5]]));
    expect(cands.map((c) => c.id)).toEqual(['1', '2']);
  });
});
