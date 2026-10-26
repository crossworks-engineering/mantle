/**
 * The responder-turn assembly runs in the agent's scope (member logins Phase
 * 0b, workspaces W5b2, W8c): for the assistant of a workspace other than
 * Admin, the skill, tool-group and tool lookups (and anything else the
 * prompt derives from the brain) run in a turn scope of that workspace,
 * never as system work. The audit removed this wrap and every test stayed
 * green; this pins it. Collaborators are faked; each records the scope it
 * runs in. withTurnScope enters the scope alone (no database).
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
  return `${s.kind}(${s.ws.join(',')})`;
}

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { runInViewerScope } = await import('@mantle/db/viewer');
  // The agent's workspace lookups (agent-viewer.ts, on the system pool)
  // without a database: a live workspace that is not Admin, and the login a
  // user there.
  const select = () => ({
    from: (table: unknown) => {
      const rows =
        table === actual.workspaces
          ? [{ isAdmin: false, ownerId: 'owner-1', archivedAt: null }]
          : [{ moderator: false }];
      const chain: Record<string, unknown> = { where: () => chain, limit: async () => rows };
      return chain;
    },
  });
  return {
    ...actual,
    db: { select },
    // A turn scope without a database: the scope alone.
    withTurnScope: vi.fn((scope: never, fn: () => Promise<unknown>) => runInViewerScope(scope, fn)),
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

/** The Team workspace's assistant, or (null) a helper on no workspace. */
const agent = (workspaceId: string | null) =>
  ({
    id: 'agent-1',
    ownerId: 'owner-1',
    slug: 'team-responder',
    workspaceId,
    model: 'm',
    provider: 'openrouter',
    systemPrompt: 'PROMPT',
    skillSlugs: ['team-skill'],
    toolGroupSlugs: ['team-read'],
    memoryConfig: {},
    params: {},
  }) as unknown as Agent;

const assemble = (workspaceId: string | null) =>
  assembleResponderTurn({
    ownerId: 'owner-1',
    agent: agent(workspaceId),
    prefs: { timezone: 'UTC', locale: 'en-GB' },
    logPrefix: '[test]',
    surface: { kind: 'team', loginId: 'u1' },
    includeIdentity: false,
    withThinking: false,
    allowDelegation: false,
  });

beforeEach(() => {
  h.levels = [];
});

describe('assembleResponderTurn runs in the agent scope', () => {
  it('the Team workspace’s assistant: skills, groups and tools resolve in its workspace scope', async () => {
    const a = await assemble('ws-team');
    expect(a.allowedTools.map((t) => t.slug)).toContain('search_nodes');
    expect(h.levels).toContain('tools:assistant(ws-team)');
    expect(h.levels.filter((l) => !l.endsWith(':assistant(ws-team)'))).toEqual([]);
  });

  it('control: a helper answering no login resolves as system work', async () => {
    await assemble(null);
    expect(h.levels).toContain('tools:admin');
    expect(h.levels.filter((l) => !l.endsWith(':admin'))).toEqual([]);
  });
});
