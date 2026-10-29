/**
 * A delegated child runs on the surface the invoke_agent builtin hands it
 * (client logins C4, plan section 8). Before C4 the child's runToolLoop got no
 * surface at all, which the owner-only tools read as the owner: a team or
 * client turn could reach them by delegating. This pins that the surface in
 * InvokeAgentInput reaches the child's runToolLoop unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runToolLoop: vi.fn(async () => ({ reply: 'child reply' })),
  /** The open workspace scope (a workspace turn's, answering a login). */
  scope: null as null | { kind: 'assistant'; loginId: string; ws: string[]; modWs: string[] },
  /** The target's memory_config, its granted tool slugs, and the slugs the
   *  child's tools were resolved from. */
  memoryConfig: null as null | Record<string, unknown>,
  slugs: [] as string[],
  resolved: [] as string[],
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const target = {
    id: 'a1',
    slug: 'presenter',
    name: 'Presenter',
    model: 'm',
    provider: 'openrouter',
    systemPrompt: 'you research',
    get memoryConfig() {
      return h.memoryConfig;
    },
    params: {},
    skillSlugs: [],
    toolGroupSlugs: [],
    enabled: true,
  };
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [target],
  };
  return {
    ...actual,
    db: { select: () => chain },
    bumpAgentUsage: vi.fn(),
    // A workspace turn's scope holds no Admin; unscoped system work does.
    adminOrSystemScope: async () => !h.scope,
  };
});
vi.mock('@mantle/db/viewer', () => ({
  currentScope: () => ({ kind: 'system' }),
  currentWorkspaceScope: () => h.scope,
}));
vi.mock('@mantle/tracing', () => ({
  log: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  startTrace: (_o: unknown, fn: () => unknown) => fn(),
  currentTrace: () => null,
}));
vi.mock('@mantle/voice', () => ({ getChatAdapter: () => ({}) }));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadProfilePreferences: async () => ({}),
}));
vi.mock('./tool-loop', () => ({
  resolveAgentTools: async (_o: string, slugs: string[]) => {
    h.resolved = slugs;
    return [];
  },
  runToolLoop: h.runToolLoop,
}));
vi.mock('./chat-failover', () => ({
  resolveBackupAdapter: async () => null,
  resolveChatKey: async () => ({ ok: true, apiKey: 'k' }),
}));
vi.mock('./skills', () => ({
  resolveAgentSkills: async () => [],
  resolveAgentToolGroups: async () => [],
  composeSystemPromptWithSkills: () => 'system',
  effectiveToolSlugs: () => h.slugs,
}));
vi.mock('./agent-viewer', () => ({
  // A helper (no workspace): no turn scope of its own.
  agentTurnScoped: async () => false,
  surfaceLoginId: () => null,
  withAgentScope: (_a: unknown, fn: () => unknown) => fn(),
}));

import { WORKSPACE_CHILD_MAX_ITERATIONS, type InvokeAgentInput } from '@mantle/tools';
import { invokeAgent } from './invoke-agent';

const BASE: InvokeAgentInput = {
  ownerId: 'o1',
  // A workspace delegate: a team or missing surface is a workspace turn,
  // whose child may be one of them only (the delegation gateway).
  agentSlug: 'presenter',
  prompt: 'look it up',
  depth: 1,
  parentTraceId: null,
};

type LoopArgs = { surface?: unknown };
const loopSurface = () => (h.runToolLoop.mock.calls as unknown as Array<[LoopArgs]>)[0]![0].surface;

beforeEach(() => {
  h.runToolLoop.mockClear();
  h.memoryConfig = null;
  h.slugs = [];
  h.resolved = [];
  h.scope = {
    kind: 'assistant',
    loginId: '00000000-0000-4000-8000-000000000002',
    ws: ['w1'],
    modWs: [],
  };
});

describe('invokeAgent passes the surface to the child loop', () => {
  it.each([
    ['team', { kind: 'team', loginId: '00000000-0000-4000-8000-000000000002' }],
    ['owner/delegate', { kind: 'owner', via: 'delegate' }],
  ] as const)('%s', async (_n, surface) => {
    const res = await invokeAgent({ ...BASE, surface });
    expect(res.ok).toBe(true);
    expect(loopSurface()).toEqual(surface);
  });

  it('passes none when the parent had none (the owner-only gate then refuses)', async () => {
    await invokeAgent(BASE);
    expect(loopSurface()).toBeUndefined();
  });
});

describe('invokeAgent re-asks the delegation gateway (workspace delegation)', () => {
  it('a workspace turn reaches no specialist off the list, before any model work', async () => {
    const res = await invokeAgent({
      ...BASE,
      agentSlug: 'presenter',
      surface: { kind: 'team', loginId: '00000000-0000-4000-8000-000000000002' },
    });
    expect(res.ok).toBe(true);
    // The row the fake table answers is the presenter's whatever the slug:
    // what is refused is the slug asked, read before the row matters.
    const off = await invokeAgent({
      ...BASE,
      agentSlug: 'toolsmith',
      surface: { kind: 'team', loginId: '00000000-0000-4000-8000-000000000002' },
    });
    expect(off.ok).toBe(false);
    expect(off.ok ? '' : off.error).toMatch(/cannot be delegated to from a workspace/);
    expect(h.runToolLoop).toHaveBeenCalledTimes(1);
  });

  it('a workspace turn that answers no login runs no child', async () => {
    h.scope = null;
    const res = await invokeAgent({ ...BASE, surface: { kind: 'team' } });
    expect(res.ok).toBe(false);
    expect(h.runToolLoop).not.toHaveBeenCalled();
  });

  it('the child of a workspace turn is shown the workspace delegates of its list only', async () => {
    await invokeAgent({
      ...BASE,
      surface: { kind: 'team', loginId: '00000000-0000-4000-8000-000000000002' },
    });
    const args = (h.runToolLoop.mock.calls as unknown as Array<[{ delegateTo?: unknown }]>)[0]![0];
    expect(args.delegateTo).toEqual([]);
  });
});

describe('invokeAgent shares the parent taint with the child loop (plan N18)', () => {
  it('the same object reaches runToolLoop, so a child read marks the parent', async () => {
    const taint = { clientSourced: false };
    await invokeAgent({ ...BASE, surface: { kind: 'owner', via: 'delegate' }, taint });
    const args = (h.runToolLoop.mock.calls as unknown as Array<[{ taint?: unknown }]>)[0]![0];
    expect(args.taint).toBe(taint);
  });
});

// A workspace turn's child gets no tool
// its user's own MCP outside Admin would not, and a shorter loop.
describe('a workspace turn’s child: its tools and its loop', () => {
  const TEAM = { kind: 'team', loginId: '00000000-0000-4000-8000-000000000002' } as const;
  const GRANTED = [
    'app_create',
    'app_update',
    'app_delete',
    'app_undelete',
    'web_search',
    'web_search_pro',
    'web_fetch',
    'circuit_verify',
    'generate_image',
    'invoke_agent',
    'file_delete',
    'page_create',
  ];
  const DROPPED = [
    'app_delete',
    'web_search',
    'web_search_pro',
    'web_fetch',
    'circuit_verify',
    'generate_image',
    'invoke_agent',
    'file_delete',
  ];

  it('drops every owner-key spend, egress and item delete; keeps the rest', async () => {
    h.slugs = GRANTED;
    await invokeAgent({ ...BASE, surface: TEAM });
    expect(h.resolved).toEqual(GRANTED.filter((s) => !DROPPED.includes(s)));
  });

  it('an Admin turn’s child keeps them all', async () => {
    h.scope = null;
    h.slugs = GRANTED;
    await invokeAgent({
      ...BASE,
      agentSlug: 'researcher',
      surface: { kind: 'owner', via: 'delegate' },
    });
    expect(h.resolved).toEqual(GRANTED);
  });

  type Loop = { maxIterations?: number };
  const loopIters = () =>
    (h.runToolLoop.mock.calls as unknown as Array<[Loop]>)[0]![0].maxIterations;

  it('the child’s iterations are clamped to WORKSPACE_CHILD_MAX_ITERATIONS', async () => {
    h.memoryConfig = { max_iterations: 30 };
    await invokeAgent({ ...BASE, surface: TEAM });
    expect(loopIters()).toBe(WORKSPACE_CHILD_MAX_ITERATIONS);
  });

  it('an Admin turn’s child keeps its own (clamped at 30)', async () => {
    h.scope = null;
    h.memoryConfig = { max_iterations: 30 };
    await invokeAgent({ ...BASE, surface: { kind: 'owner', via: 'delegate' } });
    expect(loopIters()).toBe(30);
  });
});
