import { describe, it, expect, vi } from 'vitest';
import {
  composeSystemPromptWithSkills,
  effectiveSkillSlugs,
  effectiveToolSlugs,
} from './skills';

describe('effectiveSkillSlugs', () => {
  it("unions the agent's own skills with its granted groups' usage skills", () => {
    expect(effectiveSkillSlugs(['chat_writing'], ['api-weather-tools'])).toEqual([
      'chat_writing',
      'api-weather-tools',
    ]);
  });

  it("puts the agent's own skills first and dedupes an overlap", () => {
    // An operator may also have attached the group's skill by hand — it must
    // appear once, in the operator's position.
    expect(effectiveSkillSlugs(['api-weather-tools', 'b'], ['api-weather-tools'])).toEqual([
      'api-weather-tools',
      'b',
    ]);
  });

  it('is empty when neither side contributes, and passes each side through alone', () => {
    expect(effectiveSkillSlugs([], [])).toEqual([]);
    expect(effectiveSkillSlugs(['a'], [])).toEqual(['a']);
    expect(effectiveSkillSlugs([], ['api-x'])).toEqual(['api-x']);
  });

  it('caps the union and logs what it dropped (skills cost prompt on every turn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const own = Array.from({ length: 30 }, (_, i) => `own${i}`);
    const group = Array.from({ length: 30 }, (_, i) => `api-g${i}`);
    const out = effectiveSkillSlugs(own, group);
    expect(out).toHaveLength(32);
    expect(out[0]).toBe('own0'); // the operator's own choices are kept
    expect(warn.mock.calls[0]?.[0]).toContain('exceeds cap');
    warn.mockRestore();
  });
});

describe('effectiveToolSlugs', () => {
  it('dedupes the granted-group tools (P6: groups are the sole grant)', () => {
    const out = effectiveToolSlugs(['a', 'b', 'b', 'c', 'd']);
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns an empty list for no granted groups', () => {
    expect(effectiveToolSlugs([])).toEqual([]);
  });

  it('caps the list and logs the dropped slugs (not silent)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: 600 }, (_, i) => `t${i}`);
    const out = effectiveToolSlugs(many);
    expect(out).toHaveLength(512);
    expect(out[0]).toBe('t0'); // insertion order preserved; head kept
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('exceeds cap');
    warn.mockRestore();
  });

  it('leaves a normal-sized list untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = effectiveToolSlugs(['x', 'y']);
    expect([...out].sort()).toEqual(['x', 'y']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('composeSystemPromptWithSkills — house style', () => {
  const skill = (name: string, instructions: string) => ({
    slug: name.toLowerCase(),
    name,
    description: '',
    instructions,
  });

  it('emits nothing when no house style is set', () => {
    // The prompt must stay byte-identical to a brain that predates the
    // feature — this text rides in the cached prefix of every turn.
    const withArg = composeSystemPromptWithSkills('BASE', [skill('Chat', 'CHAT')], undefined);
    const without = composeSystemPromptWithSkills('BASE', [skill('Chat', 'CHAT')]);
    expect(withArg).toBe(without);
    expect(withArg).not.toContain('House style');
  });

  it('treats a whitespace-only house style as unset', () => {
    expect(composeSystemPromptWithSkills('BASE', [], '   \n  ')).toBe('BASE');
  });

  it('appends the house style AFTER the skills, so the owner wins on conflict', () => {
    const out = composeSystemPromptWithSkills(
      'BASE',
      [skill('Chat', 'CHAT')],
      'Never use em dashes.',
    );
    expect(out.indexOf('## Skill: Chat')).toBeGreaterThan(-1);
    expect(out.indexOf('## House style')).toBeGreaterThan(out.indexOf('## Skill: Chat'));
    expect(out).toContain('Never use em dashes.');
  });

  it('carries the verbatim-material carve-out with the rule', () => {
    // Without this the rule is a correctness bug waiting to happen: an agent
    // "fixing" quoted source to satisfy a style preference.
    const out = composeSystemPromptWithSkills('BASE', [], 'Never use em dashes.');
    expect(out).toContain('Never apply it to material you are reproducing');
  });

  it('applies with no skills attached at all', () => {
    // researcher/reader-shaped agents carry no skills; the owner's style must
    // still reach them.
    const out = composeSystemPromptWithSkills('BASE', [], 'Rule one.');
    expect(out).toContain('BASE');
    expect(out).toContain('## House style');
  });
});
