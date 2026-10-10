/**
 * The responder-turn assembly runs in the agent's scope (member logins Phase
 * 0b, workspaces W5b2): for a team-level agent, the skill, tool-group and
 * tool lookups (and anything else the prompt derives from the brain) run in
 * the scope the R6 shim (withViewer) enters for it, never as system work.
 * The audit removed this wrap and every test stayed green; this pins it.
 * Collaborators are faked; each records the scope it runs in. withViewer
 * enters the scope viewerScopeFor gives an agent on no workspace.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentScope } from '@mantle/db/viewer';
import type { Agent } from '@mantle/db';

const h = vi.hoisted(() => ({ levels: [] as string[] }));

/** The scope the code runs in: 'admin' for system work, else the workspace
 *  scope's kind and workspaces. */
function where(): string {
  const s = currentScope();
  if (s.kind === 'system') return 'admin';
  if (s.kind === 'level') return `level:${s.level}`;
  return `${s.kind}(${s.ws.join(',')})`;
}

vi.mock('@mantle/db', async (importOriginal) => {
  const { runInViewerScope } = await import('@mantle/db/viewer');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    // The R6 shim without a database: 'admin' is system work; any lower
    // level enters the workspace scope of an agent on no workspace.
    withViewer: vi.fn((level: string, _for: unknown, fn: () => Promise<unknown>) =>
      level === 'admin'
        ? fn()
        : runInViewerScope({ kind: 'assistant', loginId: null, ws: [], modWs: [] }, fn),
    ),
  };
});

vi.mock('@mantle/decisions', () => ({
  loadDelegates: vi.fn(async () => []),
  suggestDelegate: vi.fn(async () => null),
  delegationHintLine: vi.fn(() => null),
}));

vi.mock('../agent', async () => {
  const rec = (what: string) => h.levels.push(`${what}:${where()}`);
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
  profileThinking: () => ({ budget: 0, effort: undefined }),
  resolveAgentThinking: () => ({ budget: 0, effort: undefined }),
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

describe('assembleResponderTurn runs in the agent scope', () => {
  it('a team agent: skills, groups and tools resolve in its workspace scope', async () => {
    const a = await assemble('team');
    expect(a.allowedTools.map((t) => t.slug)).toContain('search_nodes');
    expect(h.levels).toContain('tools:assistant()');
    expect(h.levels.filter((l) => !l.endsWith(':assistant()'))).toEqual([]);
  });

  it('control: an admin agent resolves at admin', async () => {
    await assemble('admin');
    expect(h.levels).toContain('tools:admin');
    expect(h.levels.filter((l) => !l.endsWith(':admin'))).toEqual([]);
  });
});
