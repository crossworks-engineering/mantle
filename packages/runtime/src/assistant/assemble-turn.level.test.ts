/**
 * The responder-turn assembly runs at the agent's level (member logins Phase
 * 0b): for a team-level agent, the skill, tool-group and tool lookups (and
 * anything else the prompt derives from the brain) run in the team viewer
 * scope. The audit removed this wrap and every test stayed green; this pins
 * it. Collaborators are faked; each records `currentViewerLevel()`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@mantle/db';

const h = vi.hoisted(() => ({ levels: [] as string[] }));

vi.mock('@mantle/decisions', () => ({
  loadDelegates: vi.fn(async () => []),
  suggestDelegate: vi.fn(async () => null),
  delegationHintLine: vi.fn(() => null),
}));

vi.mock('../agent', async () => {
  const { currentViewerLevel: level } = await import('@mantle/db/viewer');
  const rec = (what: string) => h.levels.push(`${what}:${level()}`);
  return {
    isBuiltinReadOnly: () => true,
    composeSystemPromptWithSkills: (prompt: string) => prompt,
    effectiveToolSlugs: (groups: Array<{ toolSlugs: string[] }>) =>
      groups.flatMap((g) => g.toolSlugs),
    resolveAgentSkills: vi.fn(async (_o: string, slugs: string[]) => {
      rec('skills');
      return slugs.map((slug) => ({ slug }));
    }),
    resolveAgentToolGroups: vi.fn(async (_o: string, slugs: string[]) => {
      rec('groups');
      return slugs.map((slug) => ({ slug, toolSlugs: ['search_nodes'] }));
    }),
    resolveAgentTools: vi.fn(async (_o: string, slugs: string[]) => {
      rec('tools');
      return slugs.map((slug) => ({ slug }));
    }),
  };
});

vi.mock('@mantle/content', () => ({
  buildIdentityContext: vi.fn(async () => ''),
  buildJournalTier1: vi.fn(async () => ''),
  journalTiersOf: () => 'off',
  buildTimeContextLine: () => 'TIME-LINE',
  resolveThinkingBudget: () => 0,
  resolveThinkingEffort: () => undefined,
}));

vi.mock('../heartbeats', () => ({
  buildOpenHeartbeatContext: () => '',
  HEARTBEAT_RESPONDER_TOOLS: [],
  hasActiveHeartbeatsOnSurface: vi.fn(async () => false),
  openHeartbeatsForSurface: vi.fn(async () => []),
}));

vi.mock('@mantle/tracing', () => ({
  maxImageBytesFor: () => 1000,
  modelSupportsVision: () => true,
  refreshModelCatalog: vi.fn(async () => {}),
}));

import { assembleResponderTurn } from './assemble-turn';

const agent = (audience: string) =>
  ({
    id: 'agent-1',
    ownerId: 'owner-1',
    slug: 'team-responder',
    audience,
    model: 'm',
    provider: 'openrouter',
    systemPrompt: 'PROMPT',
    skillSlugs: ['team-skill'],
    toolGroupSlugs: ['team-read'],
    memoryConfig: {},
    params: {},
  }) as unknown as Agent;

const assemble = (audience: string) =>
  assembleResponderTurn({
    ownerId: 'owner-1',
    agent: agent(audience),
    prefs: { timezone: 'UTC', locale: 'en-GB' },
    logPrefix: '[test]',
    includeIdentity: false,
    withThinking: false,
    allowDelegation: false,
  });

beforeEach(() => {
  h.levels = [];
});

describe('assembleResponderTurn runs at the agent level', () => {
  it('a team agent: skills, groups and tools resolve at team', async () => {
    const a = await assemble('team');
    expect(a.allowedTools.map((t) => t.slug)).toContain('search_nodes');
    expect(h.levels).toContain('tools:team');
    expect(h.levels.filter((l) => !l.endsWith(':team'))).toEqual([]);
  });

  it('control: an admin agent resolves at admin', async () => {
    await assemble('admin');
    expect(h.levels).toContain('tools:admin');
    expect(h.levels.filter((l) => !l.endsWith(':admin'))).toEqual([]);
  });
});
