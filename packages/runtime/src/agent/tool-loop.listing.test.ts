/**
 * Every tool loop lists only what the one gate lets it call (A5 step 5,
 * owner pick B, fix round 1 M1). The filter sits in the one tool loop
 * (loopToolRows in runToolLoopInScope), in the agent's scope, so a
 * delegated child turn, a heartbeat fire and a run's worker turn list what
 * an assistant turn lists: a loop in a member scope outside Admin is not
 * sent an Admin-only tool, an Admin-area tool, a create of an Admin-only
 * kind or a shell tool; an owner loop (Admin with every area) is sent every
 * tool with a policy, in the grant's order, the same bytes each time.
 *
 * The real gate and the real loop. The scope and the Admin view are stubbed
 * (no database), as in packages/tools/src/turn-listing.test.ts; the model
 * is faked and records the tools it is sent; dynamic schemas are off (a hook
 * reads the brain).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: null as null | Record<string, unknown>,
  view: { holdsAdmin: false, areas: new Set<string>() },
  traceData: [] as Record<string, unknown>[],
}));

vi.mock('../../../db/src/viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../db/src/viewer')>();
  return {
    ...real,
    currentWorkspaceScope: () => h.scope ?? real.currentWorkspaceScope(),
  };
});
vi.mock('../../../db/src/gateway/scope-answers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/src/gateway/scope-answers')>()),
  scopeHoldsAdmin: async () => h.view.holdsAdmin,
  adminOrSystemScope: async () =>
    !(await import('../../../db/src/viewer')).currentWorkspaceScope() || h.view.holdsAdmin,
  scopeHasArea: async (a: string) => h.view.holdsAdmin && h.view.areas.has(a),
}));
vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/tracing')>()),
  setTraceData: (patch: Record<string, unknown>) => h.traceData.push(patch),
}));
// The connector's resource rows (A5 step 6a, carried L1: the connector
// narrower reads them): a resource of every workspace with its Write tick,
// so only a Moderator there may call its write.
vi.mock('../../../tools/src/external-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../tools/src/external-access')>()),
  connectorGroupOf: async (_owner: string, row: { handler: { group?: string } }) => ({
    id: 'g',
    slug: row.handler.group,
    usable: true,
  }),
  connectorResources: async (_owner: string, _group: string, ws: readonly string[]) =>
    ws.map((workspaceId) => ({ workspaceId, write: true })),
}));
vi.mock('@mantle/tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/tools')>()),
  getDynamicSchema: () => null,
}));

import { loginActor, runAsActor, type Tool } from '@mantle/db';
import { BUILTIN_TOOLS, ensureGateReady } from '@mantle/tools';
import type { ChatDispatcher, ChatOptions, ChatResult } from '@mantle/voice';
import { runToolLoop } from './tool-loop';

const OWNER = '99999999-9999-4999-8999-999999999999';
const LOGIN = '55555555-5555-4555-8555-555555555555';
const ADMIN_WS = '11111111-1111-4111-8111-111111111111';
const TEAM_WS = '22222222-2222-4222-8222-222222222222';
const AREAS = ['settings', 'users', 'assistants', 'connectors', 'keys'];

const builtinRow = (slug: string) =>
  ({
    slug,
    ownerId: OWNER,
    name: slug,
    description: slug,
    handler: { kind: 'builtin', ref: slug },
    requiresConfirm: false,
    inputSchema: { type: 'object', properties: {} },
  }) as unknown as Tool;

const runtime = (slug: string, handler: Record<string, unknown>) =>
  ({
    slug,
    ownerId: OWNER,
    name: slug,
    handler,
    requiresConfirm: false,
    externalAccess: null,
    description: slug,
    inputSchema: { type: 'object', properties: {} },
  }) as unknown as Tool;

const NO_POLICY = runtime('odd', { kind: 'carrier-pigeon' });
const ROWS = [
  ...BUILTIN_TOOLS.map((d) => builtinRow(d.slug)),
  runtime('crm_lookup', { kind: 'mcp', group: 'crm', toolName: 'lookup' }),
  runtime('api_get', { kind: 'http', url: 'https://api.example.test/v1', method: 'GET' }),
  runtime('a_recipe', { kind: 'recipe', steps: [{ tool: 'search_nodes' }] }),
  runtime('shell_echo', { kind: 'shell', cmd: 'echo hi' }),
  NO_POLICY,
];

/** The tool names each model call was sent. */
let sent: string[][] = [];
function adapter(): ChatDispatcher {
  return {
    providerId: 'openrouter',
    adapterName: 'fake-chat',
    chat: vi.fn(async (opts: ChatOptions): Promise<ChatResult> => {
      sent.push((opts.tools ?? []).map((t) => t.function.name));
      return { text: 'done', model: 'fake' };
    }),
  };
}

/** The three loops that never pass through the assistant turn's assembler:
 *  each calls runToolLoop with its own shape of arguments. */
const LOOPS = {
  'a heartbeat fire': {
    agentId: 'a-hb',
    agentSlug: 'team-assistant',
    agentRole: 'assistant',
    agentDepth: 1,
    delegateTo: [],
    surface: { kind: 'team', privateReads: false },
  },
  'a delegated child turn': {
    agentId: 'a-child',
    agentSlug: 'researcher',
    agentRole: 'specialist',
    agentDepth: 2,
    delegateTo: [],
    parentTraceId: null,
  },
  'a run worker turn': {
    agentId: 'a-worker',
    agentSlug: 'run-worker',
    agentRole: 'worker',
    agentDepth: 1,
  },
} as const;

async function sentIn(
  scope: Record<string, unknown>,
  view: { holdsAdmin: boolean; areas: Set<string> },
  extra: Record<string, unknown>,
): Promise<string[]> {
  h.scope = scope;
  h.view = view;
  sent = [];
  try {
    await runAsActor(loginActor(LOGIN), () =>
      runToolLoop({
        adapter: adapter(),
        apiKey: 'k',
        model: 'm',
        params: {},
        ownerId: OWNER,
        initialMessages: [{ role: 'user', content: 'hi' }],
        tools: ROWS,
        ...extra,
      } as Parameters<typeof runToolLoop>[0]),
    );
  } finally {
    h.scope = null;
  }
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

const MEMBER = { kind: 'assistant', loginId: LOGIN, ws: [TEAM_WS], modWs: [] };
const MEMBER_VIEW = () => ({ holdsAdmin: false, areas: new Set<string>() });
const OWNER_SCOPE = { kind: 'assistant', loginId: LOGIN, ws: [ADMIN_WS], modWs: [ADMIN_WS] };
const OWNER_VIEW = () => ({ holdsAdmin: true, areas: new Set(AREAS) });

/** The owner-only builtins: none is listed on a loop whose surface is not
 *  the owner's (A5 step 6a, carried L1; dispatch refused each call). None of
 *  the three loops here runs on the owner's surface. */
const OWNER_ONLY = BUILTIN_TOOLS.filter((d) => d.ownerOnly).map((d) => d.slug);

/** The builtins a scope outside Admin is refused by the gate's scope step. */
const ADMIN_ONLY = BUILTIN_TOOLS.filter((d) => {
  const s = d.policy.scope;
  return s === 'admin' || s === 'admin-kind' || typeof s === 'object';
}).map((d) => d.slug);

beforeEach(() => {
  h.scope = null;
  h.traceData = [];
  sent = [];
});

describe('every tool loop lists only what the gate lets it call (A5 step 5 fix round 1, M1)', () => {
  ensureGateReady();

  it('there are Admin-only, Admin-area and Admin-kind builtins to hide', () => {
    const scopes = new Set(
      BUILTIN_TOOLS.map((d) => d.policy.scope).map((s) => (typeof s === 'object' ? 'area' : s)),
    );
    for (const s of ['admin', 'admin-kind', 'area']) expect(scopes.has(s as never), s).toBe(true);
  });

  for (const [name, extra] of Object.entries(LOOPS)) {
    it(`${name} in a member scope outside Admin is not sent an Admin-only, area, admin-kind or shell tool`, async () => {
      const tools = new Set(await sentIn(MEMBER, MEMBER_VIEW(), extra));
      // The connector's write row too: the member is no Moderator (A5 step
      // 6a, carried L1: before, it was sent and dispatch refused it).
      for (const slug of [...ADMIN_ONLY, ...OWNER_ONLY, 'shell_echo', 'odd', 'crm_lookup']) {
        expect(tools.has(slug), slug).toBe(false);
      }
      for (const slug of ['note_create', 'search_nodes', 'api_get', 'a_recipe']) {
        expect(tools.has(slug), slug).toBe(true);
      }
      expect(tools.has('read_result')).toBe(true);
    });

    it(`${name} in the owner's scope is sent every tool with a policy but the owner-only ones, in the grant's order`, async () => {
      const tools = await sentIn(OWNER_SCOPE, OWNER_VIEW(), extra);
      expect(tools).toEqual(
        ROWS.filter((r) => r !== NO_POLICY && !OWNER_ONLY.includes(r.slug)).map((r) => r.slug),
      );
    });
  }

  it("a loop on the owner's own surface is sent the owner-only tools too (A5 step 6a)", async () => {
    const tools = await sentIn(OWNER_SCOPE, OWNER_VIEW(), {
      ...LOOPS['a delegated child turn'],
      surface: { kind: 'web', loginId: LOGIN },
    });
    expect(tools).toEqual(ROWS.filter((r) => r !== NO_POLICY).map((r) => r.slug));
    expect(tools).toContain('tree_folders');
  });

  it('the sent list is the same bytes for the same agent and scope (the cache resets once)', async () => {
    const a = await sentIn(MEMBER, MEMBER_VIEW(), LOOPS['a heartbeat fire']);
    const b = await sentIn(MEMBER, MEMBER_VIEW(), LOOPS['a heartbeat fire']);
    expect(b).toEqual(a);
  });
});

describe("a turn's trace counts the tools the model is sent (A5 step 5 fix round 2, LOW-1)", () => {
  ensureGateReady();

  it('records tool_count as the listed tools, not the grant, when the turn asks for it', async () => {
    const tools = await sentIn(MEMBER, MEMBER_VIEW(), {
      ...LOOPS['a heartbeat fire'],
      recordToolCount: true,
    });
    expect(tools.length).toBeLessThan(ROWS.length);
    expect(h.traceData).toEqual([{ tool_count: tools.length }]);
  });

  it('records nothing for a loop that does not ask', async () => {
    await sentIn(MEMBER, MEMBER_VIEW(), LOOPS['a delegated child turn']);
    expect(h.traceData).toEqual([]);
  });
});
