import { describe, it, expect } from 'vitest';
import { pickWebDefaultAgent, ROLE_TIEBREAK, type WebDefaultCandidate } from './assistant-select';

/**
 * Web-default agent pick (docs/comms-channels.md §6, decision 5). Role is a soft
 * tiebreak only — transport is decoupled. These pin the resolution order
 * `resolveAssistantAgent` relies on after its DB fetch.
 */
const a = (over: Partial<WebDefaultCandidate>): WebDefaultCandidate => ({
  slug: 'x',
  role: 'custom',
  priority: 100,
  ...over,
});

describe('pickWebDefaultAgent', () => {
  it('returns null for no candidates', () => {
    expect(pickWebDefaultAgent([])).toBeNull();
  });

  it('picks the highest priority regardless of role', () => {
    const rows = [
      a({ slug: 'helper', role: 'assistant', priority: 10 }),
      a({ slug: 'saskia', role: 'responder', priority: 200 }),
    ];
    expect(pickWebDefaultAgent(rows)?.slug).toBe('saskia');
  });

  it('breaks equal priority with assistant→responder→custom', () => {
    const rows = [
      a({ slug: 'c', role: 'custom', priority: 100 }),
      a({ slug: 'r', role: 'responder', priority: 100 }),
      a({ slug: 'asst', role: 'assistant', priority: 100 }),
    ];
    expect(pickWebDefaultAgent(rows)?.slug).toBe('asst');
    // assistant (0) < responder (1) < custom (2)
    expect(ROLE_TIEBREAK.assistant).toBe(0);
    expect(ROLE_TIEBREAK.responder).toBe(1);
    expect(ROLE_TIEBREAK.custom).toBe(2);
  });

  it('breaks an equal priority + equal role tie by slug (deterministic)', () => {
    const rows = [
      a({ slug: 'zeta', role: 'responder', priority: 100 }),
      a({ slug: 'alpha', role: 'responder', priority: 100 }),
    ];
    // Same input either way round resolves to the same agent — the bug the
    // tiebreak fixes (non-deterministic pick among equal-priority peers).
    expect(pickWebDefaultAgent(rows)?.slug).toBe('alpha');
    expect(pickWebDefaultAgent([...rows].reverse())?.slug).toBe('alpha');
  });

  it('treats a null priority as 0', () => {
    const rows = [
      a({ slug: 'nullp', role: 'assistant', priority: null }),
      a({ slug: 'low', role: 'custom', priority: 1 }),
    ];
    expect(pickWebDefaultAgent(rows)?.slug).toBe('low');
  });

  it('does not mutate the input array order', () => {
    const rows = [
      a({ slug: 'b', priority: 1 }),
      a({ slug: 'a', priority: 9 }),
    ];
    pickWebDefaultAgent(rows);
    expect(rows.map((r) => r.slug)).toEqual(['b', 'a']);
  });
});
