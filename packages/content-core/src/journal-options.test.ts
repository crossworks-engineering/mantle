import { describe, expect, it } from 'vitest';
import {
  AGENT_KIND_KEYS,
  KIND_KEYS,
  USER_KIND_KEYS,
  kindLabel,
  kindLane,
  legacyCategoryToKind,
  normalizeEntryDate,
} from './journal-options';

describe('normalizeEntryDate', () => {
  it('passes through a full ISO timestamp (canonicalised)', () => {
    const out = normalizeEntryDate('2025-12-25T08:30:00.000Z');
    expect(out).toBe('2025-12-25T08:30:00.000Z');
  });

  it('accepts a bare date and yields a valid ISO string', () => {
    const out = normalizeEntryDate('2025-12-25');
    expect(out).not.toBeNull();
    expect(out).toMatch(/^2025-12-25T/);
    // round-trips through Date without throwing
    expect(Number.isNaN(Date.parse(out!))).toBe(false);
  });

  it('rejects free-text that is not a date — the cast-poison guard', () => {
    expect(normalizeEntryDate('next Tuesday')).toBeNull();
    expect(normalizeEntryDate('tomorrow')).toBeNull();
    expect(normalizeEntryDate('soon-ish')).toBeNull();
    expect(normalizeEntryDate('2026-13-99')).toBeNull(); // out-of-range → invalid
  });

  it('treats empty / whitespace / non-string as "no date"', () => {
    expect(normalizeEntryDate('')).toBeNull();
    expect(normalizeEntryDate('   ')).toBeNull();
    expect(normalizeEntryDate(null)).toBeNull();
    expect(normalizeEntryDate(undefined)).toBeNull();
    // @ts-expect-error — guard against a non-string slipping through at runtime
    expect(normalizeEntryDate(123)).toBeNull();
  });
});

describe('kind vocabulary', () => {
  it('splits cleanly into the two lanes', () => {
    expect(USER_KIND_KEYS).toEqual(['identity', 'context', 'preference', 'goal']);
    expect(AGENT_KIND_KEYS).toEqual(['lesson', 'expectation', 'gap']);
    expect(KIND_KEYS).toEqual([...USER_KIND_KEYS, ...AGENT_KIND_KEYS]);
  });
});

describe('kindLabel', () => {
  it('maps a known kind key to its label', () => {
    expect(kindLabel('expectation')).toBe('Expectation');
    expect(kindLabel('gap')).toBe('Open question');
  });
  it('title-cases an unknown/free-text kind', () => {
    expect(kindLabel('hobbies')).toBe('Hobbies');
  });
  it('returns null for no kind', () => {
    expect(kindLabel(null)).toBeNull();
  });
});

describe('kindLane', () => {
  it('routes agent kinds to the agent lane', () => {
    expect(kindLane('lesson')).toBe('agent');
    expect(kindLane('expectation')).toBe('agent');
    expect(kindLane('gap')).toBe('agent');
  });
  it('routes user kinds — and anything unknown — to the user lane', () => {
    expect(kindLane('identity')).toBe('user');
    expect(kindLane('made-up')).toBe('user');
    expect(kindLane(null)).toBe('user');
  });
});

describe('legacyCategoryToKind', () => {
  it('carries identity and goal over', () => {
    expect(legacyCategoryToKind('identity')).toBe('identity');
    expect(legacyCategoryToKind('goal')).toBe('goal');
  });
  it('maps every other legacy life area (and none) to context', () => {
    expect(legacyCategoryToKind('work')).toBe('context');
    expect(legacyCategoryToKind('faith')).toBe('context');
    expect(legacyCategoryToKind('emotion')).toBe('context');
    expect(legacyCategoryToKind(null)).toBe('context');
  });
});
