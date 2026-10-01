import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  candidates: [] as unknown[],
  passages: new Map<string, string>(),
  loads: 0,
}));

vi.mock('@mantle/content', async () => {
  const actual = await vi.importActual<typeof import('@mantle/content')>('@mantle/content');
  return {
    ...actual,
    loadJournalCandidates: vi.fn(async () => {
      h.loads++;
      return { candidates: h.candidates, passages: h.passages };
    }),
  };
});

import {
  journalSnapshot,
  journalTierConfig,
  journalTiersForTurn,
  passageKey,
} from './journal-tiers';

const c = (nodeId: string, kind: string, similarity: number, body = `${nodeId} body`) => ({
  nodeId,
  kind,
  similarity,
  body,
  agentSlug: null,
  status: null,
});

const scoring = (mode: 'shadow' | 'live', scores: Record<string, number>) => ({
  scores: new Map(Object.entries(scores)),
  mode,
  threshold: 1.5,
  calls: 1,
  failed: 0,
  skipped: 0,
  cached: false,
  ms: 10,
});

const base = {
  ownerId: 'o',
  agentSlug: 'assistant',
  inboundText: 'how do I format the weekly report',
  queryVec: [0.1],
  userLane: true,
  agentLane: true,
  cutoff: 0.7,
  budgetChars: 3000,
};

beforeEach(() => {
  h.candidates = [];
  h.passages = new Map();
  h.loads = 0;
});

describe('journalTierConfig', () => {
  it('clamps typos instead of blanking or flooding the tiers', () => {
    expect(journalTierConfig({})).toEqual({ cutoff: 0.7, budgetChars: 3000 });
    expect(journalTierConfig({ journal_relevance_min: 7, journal_relevant_chars: 0 })).toEqual({
      cutoff: 1,
      budgetChars: 200,
    });
    expect(journalTierConfig({ journal_relevant_chars: 1e9 }).budgetChars).toBe(20_000);
  });
});

describe('journalTiersForTurn', () => {
  it('small talk: no load, no pick; tier 1 whole entries still count as redundant', async () => {
    const t = await journalTiersForTurn({
      ...base,
      inboundText: 'thanks!',
      tier1: {
        shown: [{ nodeId: 't1', kind: 'identity', body: 'x', whole: true }],
        overflow: [],
        chars: 1,
      },
      recall: null,
    });
    expect(h.loads).toBe(0);
    expect(t.relevance.skipped).toBe('small_talk');
    expect([...t.wholeIds]).toEqual(['t1']);
  });

  it('a whole pick is redundant as a node; a passage only as its own chunk', async () => {
    h.candidates = [c('short', 'context', 0.9), c('long', 'context', 0.85, 'L '.repeat(1000))];
    h.passages = new Map([['long', 'the   matching\npassage']]);
    const t = await journalTiersForTurn({ ...base, tier1: null, recall: null });
    expect([...t.wholeIds]).toEqual(['short']);
    expect(t.passageKeys.has(passageKey('long', 'the matching passage'))).toBe(true);
  });

  it('shadow: similarity decides; Jev pick traced from the SAME load', async () => {
    h.candidates = [c('r1', 'lesson', 0.2), c('r2', 'lesson', 0.9)];
    const rules = [
      { nodeId: 'r1', kind: 'lesson', agentSlug: null, body: 'r1 body' },
      { nodeId: 'r2', kind: 'lesson', agentSlug: null, body: 'r2 body' },
    ];
    const t = await journalTiersForTurn({
      ...base,
      tier1: null,
      recall: { rules, scoring: scoring('shadow', { r1: 2.5, r2: 0.5 }) },
    });
    expect(h.loads).toBe(1);
    expect(t.relevance.picks.map((p) => p.nodeId)).toEqual(['r2']);
    expect(t.jevPicks.map((p) => p.nodeId)).toEqual(['r1']);
  });

  it('live: Jev decides the rules it scored', async () => {
    h.candidates = [c('r1', 'lesson', 0.2), c('r2', 'lesson', 0.9)];
    const t = await journalTiersForTurn({
      ...base,
      tier1: null,
      recall: { rules: [], scoring: scoring('live', { r1: 2.5, r2: 0.5 }) },
    });
    expect(t.relevance.picks.map((p) => p.nodeId)).toEqual(['r1']);
  });

  it('entries shown in tier 1 never come back in tier 2', async () => {
    h.candidates = [c('p1', 'preference', 0.95), c('p2', 'preference', 0.95)];
    const t = await journalTiersForTurn({
      ...base,
      tier1: {
        shown: [{ nodeId: 'p1', kind: 'preference', body: 'p1 body', whole: true }],
        overflow: [{ nodeId: 'p2', kind: 'preference', body: 'p2 body', whole: true }],
        chars: 7,
      },
      recall: null,
    });
    expect(t.relevance.picks.map((p) => p.nodeId)).toEqual(['p2']);
  });
});

describe('journalSnapshot', () => {
  it('records tier 1, the picks and the recall counts', () => {
    const snap = journalSnapshot({
      mode: 'shadow',
      turn: {
        relevance: { picks: [], gap: null, nearMisses: [], cutoff: 0.7, chars: 0, skipped: null },
        jevPicks: [],
        wholeIds: new Set(),
        passageKeys: new Set(),
      },
      tier1: {
        shown: [],
        overflow: [{ nodeId: 'x', kind: 'goal', body: 'b', whole: true }],
        chars: 0,
      },
      recall: { rules: [], scoring: scoring('shadow', {}) },
      dedupe: { facts: 0, chunkHits: 0, contentHits: 0 },
    });
    expect(snap.tier1).toEqual({ shown: 0, overflow: 1, chars: 0 });
    expect(snap.recall).toMatchObject({ mode: 'shadow', skipped: 0, rules: 0 });
  });
});
