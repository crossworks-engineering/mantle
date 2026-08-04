import { describe, it, expect, vi } from 'vitest';
import {
  AGENT_NAME_TOKEN,
  applyAgentName,
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
    id: `id-${name.toLowerCase()}`,
    slug: name.toLowerCase(),
    name,
    description: '',
    instructions,
  });

  it('emits nothing when no house style is set', () => {
    // The prompt must stay byte-identical to a brain that predates the
    // feature — this text rides in the cached prefix of every turn.
    const withArg = composeSystemPromptWithSkills('BASE', [skill('Chat', 'CHAT')], {
      agentName: 'A',
    });
    const without = composeSystemPromptWithSkills('BASE', [skill('Chat', 'CHAT')], {
      agentName: 'A',
      houseStyle: undefined,
    });
    expect(withArg).toBe(without);
    expect(withArg).not.toContain('House style');
  });

  it('treats a whitespace-only house style as unset', () => {
    expect(
      composeSystemPromptWithSkills('BASE', [], { agentName: 'A', houseStyle: '   \n  ' }),
    ).toBe('BASE');
  });

  it('appends the house style AFTER the skills, so the owner wins on conflict', () => {
    const out = composeSystemPromptWithSkills('BASE', [skill('Chat', 'CHAT')], {
      agentName: 'A',
      houseStyle: 'Never use em dashes.',
    });
    expect(out.indexOf('## Skill: Chat')).toBeGreaterThan(-1);
    expect(out.indexOf('## House style')).toBeGreaterThan(out.indexOf('## Skill: Chat'));
    expect(out).toContain('Never use em dashes.');
  });

  it('carries the verbatim-material carve-out with the rule', () => {
    // Without this the rule is a correctness bug waiting to happen: an agent
    // "fixing" quoted source to satisfy a style preference.
    const out = composeSystemPromptWithSkills('BASE', [], {
      agentName: 'A',
      houseStyle: 'Never use em dashes.',
    });
    expect(out).toContain('Never apply it to material you are reproducing');
  });

  it('applies with no skills attached at all', () => {
    // researcher/reader-shaped agents carry no skills; the owner's style must
    // still reach them.
    const out = composeSystemPromptWithSkills('BASE', [], {
      agentName: 'A',
      houseStyle: 'Rule one.',
    });
    expect(out).toContain('BASE');
    expect(out).toContain('## House style');
  });
});

/**
 * `{{name}}` resolution. Two bugs converge here: renaming an agent used to
 * leave its prompt introducing the old name (`updateAgent` writes `name`, never
 * `system_prompt`), and a per-login assistant — a COPY of another agent's
 * prompt — answered as the agent it was copied from.
 */
describe('applyAgentName', () => {
  it('resolves the token to the agent’s name, every occurrence', () => {
    const out = applyAgentName(`You are ${AGENT_NAME_TOKEN}. Be ${AGENT_NAME_TOKEN}.`, 'Tommy');
    expect(out).toBe('You are Tommy. Be Tommy.');
  });

  it('leaves a prompt with no token byte-identical', () => {
    // Block 1 of every turn is the cached prefix. An existing brain must not
    // see a single byte change until it opts into the token.
    const prompt = 'You are Mira — an RBI specialist.';
    expect(applyAgentName(prompt, 'Tommy')).toBe(prompt);
  });

  it('never touches {{secret:…}} — a different mechanism, resolved elsewhere', () => {
    // The toolsmith skill's instructions contain this syntax verbatim; a greedy
    // {{…}} matcher would corrupt the example it teaches from.
    const prompt = `You are ${AGENT_NAME_TOKEN}. Use {{secret:openweathermap/default}} as the ref.`;
    expect(applyAgentName(prompt, 'Tommy')).toBe(
      'You are Tommy. Use {{secret:openweathermap/default}} as the ref.',
    );
  });

  it('leaves the token alone for a blank name rather than going nameless', () => {
    const prompt = `You are ${AGENT_NAME_TOKEN}.`;
    expect(applyAgentName(prompt, '   ')).toBe(prompt);
    expect(applyAgentName(prompt, '')).toBe(prompt);
  });
});

describe('composeSystemPromptWithSkills — name resolution', () => {
  const skill = (name: string, instructions: string) => ({
    id: `id-${name.toLowerCase()}`,
    slug: name.toLowerCase(),
    name,
    description: '',
    instructions,
  });

  it('resolves the token in the base prompt', () => {
    const out = composeSystemPromptWithSkills(`You are ${AGENT_NAME_TOKEN}.`, [], {
      agentName: 'Tommy',
    });
    expect(out).toBe('You are Tommy.');
  });

  it('resolves it inside skill bodies and the house style too', () => {
    // Substitution runs over the COMPOSED text, so a skill that refers to the
    // assistant by name works without every skill knowing the agent.
    const out = composeSystemPromptWithSkills(
      'BASE',
      [skill('Chat', `Sign off as ${AGENT_NAME_TOKEN}.`)],
      { agentName: 'Tommy', houseStyle: `${AGENT_NAME_TOKEN} never uses em dashes.` },
    );
    expect(out).toContain('Sign off as Tommy.');
    expect(out).toContain('Tommy never uses em dashes.');
    expect(out).not.toContain(AGENT_NAME_TOKEN);
  });
});
