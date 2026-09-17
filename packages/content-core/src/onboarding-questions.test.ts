import { describe, expect, it } from 'vitest';
import {
  PURPOSE_ARCHETYPES,
  PURPOSE_ARCHETYPE_KEYS,
  isPurposeArchetype,
  purposeArchetypeLabel,
  deriveDisplayName,
} from './onboarding-questions';

describe('PURPOSE_ARCHETYPES', () => {
  it('has a stable set with unique keys', () => {
    const keys = PURPOSE_ARCHETYPES.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThanOrEqual(2);
  });

  it("leads with 'personal' and trails with the 'custom' escape hatch", () => {
    expect(PURPOSE_ARCHETYPES[0]!.key).toBe('personal');
    expect(PURPOSE_ARCHETYPES[PURPOSE_ARCHETYPES.length - 1]!.key).toBe('custom');
  });

  it('every archetype has a label and a blurb', () => {
    for (const a of PURPOSE_ARCHETYPES) {
      expect(a.label.trim().length).toBeGreaterThan(0);
      expect(a.blurb.trim().length).toBeGreaterThan(0);
    }
  });

  it('PURPOSE_ARCHETYPE_KEYS mirrors the archetype keys', () => {
    expect([...PURPOSE_ARCHETYPE_KEYS]).toEqual(PURPOSE_ARCHETYPES.map((a) => a.key));
  });
});

describe('isPurposeArchetype', () => {
  it('accepts known keys', () => {
    expect(isPurposeArchetype('personal')).toBe(true);
    expect(isPurposeArchetype('analytics')).toBe(true);
    expect(isPurposeArchetype('custom')).toBe(true);
  });

  it('rejects unknown values and non-strings', () => {
    expect(isPurposeArchetype('nope')).toBe(false);
    expect(isPurposeArchetype('')).toBe(false);
    expect(isPurposeArchetype(undefined)).toBe(false);
    expect(isPurposeArchetype(42)).toBe(false);
  });
});

describe('purposeArchetypeLabel', () => {
  it('maps a known key to its label', () => {
    expect(purposeArchetypeLabel('personal')).toBe('Personal brain');
  });

  it('returns null for unknown / blank keys', () => {
    expect(purposeArchetypeLabel('nope')).toBeNull();
    expect(purposeArchetypeLabel('')).toBeNull();
    expect(purposeArchetypeLabel(null)).toBeNull();
    expect(purposeArchetypeLabel(undefined)).toBeNull();
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
