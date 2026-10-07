import { describe, expect, it } from 'vitest';
import {
  AGENT_THINKING_EFFORTS,
  NO_THINKING,
  applyAgentThinking,
  parseAgentThinkingEffort,
  profileThinking,
  resolveAgentThinking,
  thinkingBudgetForEffort,
} from './profile-projections';

const ON_MEDIUM = { streamThoughts: true, thinkingBudget: 4096 };
const ON_OFF = { streamThoughts: true, thinkingBudget: 0 };
const SWITCH_OFF = { streamThoughts: false, thinkingBudget: 8000 };

describe('resolveAgentThinking: the precedence table', () => {
  // [agent effort, profile, expected]
  const rows: Array<[string | null, typeof ON_MEDIUM | null, number, string | undefined]> = [
    // Inherit = today's behaviour exactly.
    [null, ON_MEDIUM, 4096, 'medium'],
    [null, ON_OFF, 0, undefined],
    [null, SWITCH_OFF, 0, undefined],
    [null, null, 0, undefined],
    // Own 'off' beats any profile.
    ['off', ON_MEDIUM, 0, undefined],
    ['off', SWITCH_OFF, 0, undefined],
    // Own tier beats the profile, the profile's Off, and the display switch.
    ['low', ON_MEDIUM, 1024, 'low'],
    ['high', ON_OFF, 8000, 'high'],
    ['medium', SWITCH_OFF, 4096, 'medium'],
    ['xhigh', null, 16000, 'xhigh'],
    ['max', ON_MEDIUM, 24000, 'max'],
  ];
  for (const [own, prefs, budget, effort] of rows) {
    it(`agent ${own ?? 'inherit'} + profile ${JSON.stringify(prefs)} → ${budget}/${effort}`, () => {
      expect(resolveAgentThinking({ thinkingEffort: own }, prefs)).toEqual({ budget, effort });
    });
  }

  it('a missing agent row is inherit', () => {
    expect(resolveAgentThinking(null, ON_MEDIUM)).toEqual(profileThinking(ON_MEDIUM));
    expect(resolveAgentThinking(undefined, ON_MEDIUM)).toEqual({ budget: 4096, effort: 'medium' });
  });

  it('a bad stored value is inherit, never reasoning on', () => {
    for (const bad of ['', 'inherit', 'HIGH', 'none', 'extreme']) {
      expect(resolveAgentThinking({ thinkingEffort: bad }, ON_OFF)).toEqual(NO_THINKING);
    }
  });
});

describe('applyAgentThinking', () => {
  it('passes the inherited value through untouched on inherit', () => {
    const inherited = { budget: 2048, effort: undefined };
    expect(applyAgentThinking({ thinkingEffort: null }, inherited)).toBe(inherited);
  });
});

describe('agent effort vocabulary', () => {
  it("is 'off' plus every provider tier, in order", () => {
    expect(AGENT_THINKING_EFFORTS).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('parses only known values', () => {
    expect(parseAgentThinkingEffort('max')).toBe('max');
    expect(parseAgentThinkingEffort('off')).toBe('off');
    expect(parseAgentThinkingEffort(null)).toBeNull();
    expect(parseAgentThinkingEffort(3)).toBeNull();
  });

  it('backs the profile tiers with their own ids, the upper rungs with more headroom', () => {
    expect(thinkingBudgetForEffort('low')).toBe(1024);
    expect(thinkingBudgetForEffort('medium')).toBe(4096);
    expect(thinkingBudgetForEffort('high')).toBe(8000);
    expect(thinkingBudgetForEffort('xhigh')).toBe(16000);
    expect(thinkingBudgetForEffort('max')).toBe(24000);
  });
});
