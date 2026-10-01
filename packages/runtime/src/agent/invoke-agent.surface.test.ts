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
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const target = {
    id: 'a1',
    slug: 'researcher',
    name: 'Researcher',
    model: 'm',
    provider: 'openrouter',
    systemPrompt: 'you research',
    memoryConfig: null,
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
  return { ...actual, db: { select: () => chain }, bumpAgentUsage: vi.fn() };
});
vi.mock('@mantle/db/viewer', () => ({
  currentViewerLevel: () => 'admin',
  levelsMeet: () => true,
}));
vi.mock('@mantle/tracing', () => ({
  startTrace: (_o: unknown, fn: () => unknown) => fn(),
  currentTrace: () => null,
}));
vi.mock('@mantle/voice', () => ({ getChatAdapter: () => ({}) }));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadProfilePreferences: async () => ({}),
}));
vi.mock('./tool-loop', () => ({
  resolveAgentTools: async () => [],
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
  effectiveToolSlugs: () => [],
}));
vi.mock('./agent-viewer', () => ({ agentLevel: () => 'admin' }));

import type { InvokeAgentInput } from '@mantle/tools';
import { invokeAgent } from './invoke-agent';

const BASE: InvokeAgentInput = {
  ownerId: 'o1',
  agentSlug: 'researcher',
  prompt: 'look it up',
  depth: 1,
  parentTraceId: null,
};

type LoopArgs = { surface?: unknown };
const loopSurface = () => (h.runToolLoop.mock.calls as unknown as Array<[LoopArgs]>)[0]![0].surface;

beforeEach(() => h.runToolLoop.mockClear());

describe('invokeAgent passes the surface to the child loop', () => {
  it.each([
    ['team', { kind: 'team', loginId: '00000000-0000-4000-8000-000000000002' }],
    ['client', { kind: 'client', loginId: '00000000-0000-4000-8000-000000000001' }],
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

describe('invokeAgent shares the parent taint with the child loop (plan N18)', () => {
  it('the same object reaches runToolLoop, so a child read marks the parent', async () => {
    const taint = { clientSourced: false };
    await invokeAgent({ ...BASE, taint });
    const args = (h.runToolLoop.mock.calls as unknown as Array<[{ taint?: unknown }]>)[0]![0];
    expect(args.taint).toBe(taint);
  });
});
