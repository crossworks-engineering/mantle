import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERSONA_NAMES,
  PERSONA_NAME_TOKEN,
  PERSONA_PRESETS,
  buildPersonaPrompt,
  type PersonaPresetKey,
} from './persona-bank';

const KEYS: PersonaPresetKey[] = ['warm', 'professional', 'playful', 'concise'];

describe('PERSONA_PRESETS', () => {
  it('exposes the four presets, warm first (the Saskia default)', () => {
    expect(PERSONA_PRESETS.map((p) => p.key)).toEqual(KEYS);
    expect(PERSONA_PRESETS[0]!.key).toBe('warm');
  });

  it('gives each preset a sane default temperature in [0,1]', () => {
    for (const p of PERSONA_PRESETS) {
      expect(p.temperature).toBeGreaterThanOrEqual(0);
      expect(p.temperature).toBeLessThanOrEqual(1);
    }
  });
});

describe('buildPersonaPrompt', () => {
  it('carries the NAME TOKEN, never a baked-in name, for every preset', () => {
    for (const key of KEYS) {
      const prompt = buildPersonaPrompt(key, { gender: 'female' });
      expect(prompt).toContain(PERSONA_NAME_TOKEN);
      expect(prompt.length).toBeGreaterThan(200);
      // leans on the always-on identity block rather than hard-coding the user
      expect(prompt).toContain('About the user');
    }
  });

  it('bakes in no default name either — including Saskia', () => {
    // The regression this guards: a name interpolated at BUILD time and a name
    // stored on the agent row are two columns nothing keeps in step. Renaming
    // the agent left the prompt introducing the old name, and a cloned
    // per-login assistant answered as the agent it was copied from.
    for (const key of KEYS) {
      for (const gender of ['female', 'male'] as const) {
        const prompt = buildPersonaPrompt(key, { gender });
        expect(prompt).not.toContain(DEFAULT_PERSONA_NAMES.female);
        expect(prompt).not.toContain(DEFAULT_PERSONA_NAMES.male);
      }
    }
  });

  it('reflects gender in the self-description and pronoun', () => {
    // Gender IS baked in: it is fixed when the persona is created and drives
    // prose that has no single-token substitution (woman/man, her/him).
    const female = buildPersonaPrompt('warm', { gender: 'female' });
    const male = buildPersonaPrompt('warm', { gender: 'male' });
    expect(female).toContain('woman');
    expect(female).toContain(' her.');
    expect(male).toContain('man');
    expect(male).toContain(' him.');
  });

  it('falls back to the warm preset for an unknown key', () => {
    const warm = buildPersonaPrompt('warm', { gender: 'female' });
    const unknown = buildPersonaPrompt('nope' as PersonaPresetKey, { gender: 'female' });
    expect(unknown).toBe(warm);
  });
});
