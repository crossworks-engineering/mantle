import { describe, expect, it } from 'vitest';
import { CATEGORY_KEYS } from './lifelog-options';
import {
  ONBOARDING_QUESTIONS,
  composeBody,
  deriveDisplayName,
} from './onboarding-questions';

describe('ONBOARDING_QUESTIONS', () => {
  it('has a stable set with unique keys', () => {
    const keys = ONBOARDING_QUESTIONS.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThanOrEqual(9);
  });

  it('only files answers under real Life Log categories', () => {
    for (const q of ONBOARDING_QUESTIONS) {
      expect(CATEGORY_KEYS).toContain(q.category);
    }
  });

  it('starts with the two required name questions', () => {
    expect(ONBOARDING_QUESTIONS[0]!.key).toBe('full_name');
    expect(ONBOARDING_QUESTIONS[0]!.optional).toBe(false);
    expect(ONBOARDING_QUESTIONS[1]!.key).toBe('nickname');
    expect(ONBOARDING_QUESTIONS[1]!.optional).toBe(false);
  });
});

describe('composeBody', () => {
  it('prepends the lead to the answer', () => {
    expect(composeBody({ lead: 'My name is' }, 'Jason Schoeman')).toBe(
      'My name is Jason Schoeman',
    );
  });

  it('stores a lead-less (free-text) answer verbatim', () => {
    expect(composeBody({ lead: '' }, 'Be direct with me; no fluff.')).toBe(
      'Be direct with me; no fluff.',
    );
  });

  it('trims and returns empty for a blank answer (so the caller can skip)', () => {
    expect(composeBody({ lead: 'My name is' }, '   ')).toBe('');
    expect(composeBody({ lead: '' }, '')).toBe('');
  });
});

describe('deriveDisplayName', () => {
  it('takes the first name from a full name', () => {
    expect(deriveDisplayName('Jason Schoeman')).toBe('Jason');
    expect(deriveDisplayName('  Mary  Jane  Watson ')).toBe('Mary');
  });

  it('falls back to the whole token when there is no space', () => {
    expect(deriveDisplayName('Cher')).toBe('Cher');
  });

  it('returns empty for blank input', () => {
    expect(deriveDisplayName('   ')).toBe('');
  });
});
