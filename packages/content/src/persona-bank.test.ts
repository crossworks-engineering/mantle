import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERSONA_NAMES,
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
  it('embeds the chosen assistant name and renders for every preset', () => {
    for (const key of KEYS) {
      const prompt = buildPersonaPrompt(key, { assistantName: 'Aria', gender: 'female' });
      expect(prompt).toContain('Aria');
      expect(prompt.length).toBeGreaterThan(200);
      // leans on the always-on identity block rather than hard-coding the user
      expect(prompt).toContain('About the user');
    }
  });

  it('reflects gender in the self-description and pronoun', () => {
    const female = buildPersonaPrompt('warm', { assistantName: 'Saskia', gender: 'female' });
    const male = buildPersonaPrompt('warm', { assistantName: 'Sebastian', gender: 'male' });
    expect(female).toContain('woman');
    expect(female).toContain(' her.');
    expect(male).toContain('man');
    expect(male).toContain(' him.');
  });

  it('falls back to the default name for the gender when name is blank', () => {
    const prompt = buildPersonaPrompt('warm', { assistantName: '   ', gender: 'male' });
    expect(prompt).toContain(DEFAULT_PERSONA_NAMES.male);
  });

  it('falls back to the warm preset for an unknown key', () => {
    const warm = buildPersonaPrompt('warm', { assistantName: 'X', gender: 'female' });
    const unknown = buildPersonaPrompt('nope' as PersonaPresetKey, {
      assistantName: 'X',
      gender: 'female',
    });
    expect(unknown).toBe(warm);
  });
});
