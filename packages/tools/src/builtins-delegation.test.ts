/**
 * Behavioural tests for invoke_agent, the delegation handler. The pure
 * guards (depth cap, allowlist, self-call, the terminal-edge predicate) are
 * covered in invoke-agent-guards.test.ts; nothing exercised the HANDLER,
 * which is where those guards are wired in front of the child turn.
 *
 * What is worth pinning, in order of blast radius:
 *
 *  - Order. Every refusal (missing parent context, empty args, allowlist,
 *    depth) fires BEFORE the registered invoker runs. A guard that fires
 *    after the child turn has already spent the child's budget is not a
 *    guard, and a recursion guard that runs late is the loop it exists to
 *    stop.
 *  - The terminal-edge lookup is owner-scoped and fails closed. The one
 *    exception to the depth cap consults the agents table for the TARGET's
 *    delegate_to; that select must carry the caller's owner id, the target
 *    slug and enabled=true, and a missing target counts as non-terminal.
 *  - No lookup at all when the base cap allows: a depth-1 parent never
 *    touches the table.
 *  - The child receives the parent's owner id, the next depth, the parent
 *    trace id, the thinking budget, and a prompt carrying the subject ids
 *    and the user's verbatim ask (unless the parent quoted it already).
 *  - The success and failure output shapes, and the cost surfaced on the
 *    parent step's meta.
 *
 * The bridge is stubbed at ./agent-bridge; the agents table at the db
 * select chain, whose where clause is walked for its bound params.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const selectQueue: unknown[][] = [];
const whereArgs: unknown[] = [];
/** The open workspace scope the gateway reads (null: none), and whether it
 *  holds the Admin workspace. */
const scope = vi.hoisted(() => ({
  open: null as null | { kind: 'assistant'; loginId: string | null; ws: string[]; modWs: string[] },
  holdsAdmin: true,
}));
vi.mock('@mantle/db/viewer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentWorkspaceScope: () => scope.open,
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, arg: unknown) {
      whereArgs.push(arg);
      return this;
    }),
    limit: vi.fn().mockReturnThis(),
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
      Promise.resolve(selectQueue.shift() ?? []).then(res, rej),
  };
  return {
    ...actual,
    db: { ...actual.db, select: vi.fn(() => chain) },
    scopeHoldsAdmin: vi.fn(async () => scope.holdsAdmin),
  };
});
/** The turn's trace as the handler reads it (currentTrace). */
const trace = vi.hoisted(() => ({
  now: null as null | {
    tokens: { in: number; out: number };
    delegatedTokens?: { in: number; out: number };
  },
}));
vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentTrace: () => trace.now,
}));
vi.mock('./agent-bridge', () => ({ getAgentInvoker: vi.fn(), registerAgentInvoker: vi.fn() }));

import * as dbmod from '@mantle/db';
import { getAgentInvoker, type AgentInvoker } from './agent-bridge';
import { invoke_agent, NO_PARENT_AGENT_ERROR } from './builtins-delegation';
import {
  WORKSPACE_DELEGATE_SLUGS,
  WORKSPACE_DELEGATION_BUDGET_ERROR,
  WORKSPACE_DELEGATION_COUNT_ERROR,
  WORKSPACE_DELEGATION_TOKEN_FLOOR,
} from './invoke-agent-guards';
import { newTurnTaint } from './client-sourced';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** Bound parameter values of a drizzle SQL tree, in order. */
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const o = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
  if (Array.isArray(o.queryChunks)) for (const c of o.queryChunks) paramsOf(c, out);
  else if ('value' in o && 'encoder' in o) out.push(o.value);
  return out;
}

const invoker = vi.fn<AgentInvoker>();
const USER_ASK = 'Find the Q3 numbers and put them in the runbook';

/** A responder at the entry point, allowed to reach the researcher. */
function parent(over: Partial<NonNullable<ToolHandlerContext['agent']>> = {}): ToolHandlerContext {
  return {
    ownerId: 'o1',
    // The owner's web chat, unscoped (an Admin turn): the allowlist alone.
    surface: { kind: 'web' },
    agent: {
      slug: 'responder',
      depth: 1,
      delegateTo: ['researcher'],
      parentTraceId: 'pt1',
      thinkingBudget: 2048,
      lastUserMessage: USER_ASK,
      ...over,
    },
  };
}

const ARGS = { agent_slug: 'researcher', prompt: 'Look up the Q3 revenue.' };

beforeEach(() => {
  vi.clearAllMocks();
  scope.open = null;
  scope.holdsAdmin = true;
  trace.now = null;
  selectQueue.length = 0;
  whereArgs.length = 0;
  vi.mocked(getAgentInvoker).mockReturnValue(invoker);
  invoker.mockResolvedValue({
    ok: true,
    text: 'done',
    costMicroUsd: 12,
    tokensIn: 3,
    tokensOut: 4,
    childTraceId: 'ct1',
  });
});

describe('invoke_agent guards run before the child turn', () => {
  it('refuses an agent turn without parent agent context and names it as a wiring bug', async () => {
    for (const entry of ['turn', 'run'] as const) {
      const ctx = { ownerId: 'o1', caller: { entry, via: 'turn' } } as ToolHandlerContext;
      expect(errorOf(await invoke_agent.handler(ARGS, ctx))).toMatch(
        /missing parent agent context/,
      );
    }
    expect(invoker).not.toHaveBeenCalled();
  });

  it('a call from outside any agent turn (an MCP connection) is told to use ask_responder', async () => {
    const mcp = { ownerId: 'o1', caller: { entry: 'mcp', via: 'oauth' } } as ToolHandlerContext;
    for (const ctx of [mcp, { ownerId: 'o1' }]) {
      const error = errorOf(await invoke_agent.handler(ARGS, ctx));
      expect(error).toBe(NO_PARENT_AGENT_ERROR);
      expect(error).toMatch(/call ask_responder with agent_slug/);
      expect(error).not.toMatch(/wiring/);
    }
    expect(invoker).not.toHaveBeenCalled();
  });

  it('requires agent_slug and prompt', async () => {
    expect(errorOf(await invoke_agent.handler({ prompt: 'x' }, parent()))).toMatch(
      /agent_slug is required/,
    );
    expect(errorOf(await invoke_agent.handler({ agent_slug: 'researcher' }, parent()))).toMatch(
      /prompt is required/,
    );
    expect(invoker).not.toHaveBeenCalled();
  });

  it('refuses a target outside the allowlist and a self-call, without a lookup', async () => {
    expect(errorOf(await invoke_agent.handler(ARGS, parent({ delegateTo: [] })))).toMatch(
      /delegation not configured/,
    );
    expect(
      errorOf(
        await invoke_agent.handler(
          { ...ARGS, agent_slug: 'responder' },
          parent({ delegateTo: ['responder'] }),
        ),
      ),
    ).toMatch(/cannot invoke itself/);
    expect(invoker).not.toHaveBeenCalled();
    expect(dbmod.db.select).not.toHaveBeenCalled();
  });

  it('a depth-1 parent delegates without consulting the agents table', async () => {
    outputOf(await invoke_agent.handler(ARGS, parent()));
    expect(dbmod.db.select).not.toHaveBeenCalled();
    expect(invoker).toHaveBeenCalledWith(expect.objectContaining({ depth: 2 }));
  });

  it('refuses a depth-2 parent whose target has delegates of its own; the lookup is owner-scoped', async () => {
    selectQueue.push([{ memoryConfig: { delegate_to: ['coder'] } }]);
    const res = await invoke_agent.handler(
      { ...ARGS, agent_slug: 'toolsmith' },
      parent({ slug: 'appsmith', depth: 2, delegateTo: ['toolsmith'] }),
    );
    expect(errorOf(res)).toMatch(/depth limit/);
    expect(invoker).not.toHaveBeenCalled();
    const params = paramsOf(whereArgs[0]);
    expect(params).toContain('o1');
    expect(params).toContain('toolsmith');
    expect(params).toContain(true);
  });

  it('lets a depth-2 parent reach a TERMINAL specialist at depth 3', async () => {
    selectQueue.push([{ memoryConfig: {} }]);
    const res = await invoke_agent.handler(
      { ...ARGS, agent_slug: 'toolsmith' },
      parent({ slug: 'appsmith', depth: 2, delegateTo: ['toolsmith'] }),
    );
    outputOf(res);
    expect(invoker).toHaveBeenCalledWith(expect.objectContaining({ depth: 3 }));
  });

  it('fails closed at depth 2 when the target row is missing', async () => {
    selectQueue.push([]);
    const res = await invoke_agent.handler(
      { ...ARGS, agent_slug: 'toolsmith' },
      parent({ slug: 'appsmith', depth: 2, delegateTo: ['toolsmith'] }),
    );
    expect(errorOf(res)).toMatch(/depth limit/);
    expect(invoker).not.toHaveBeenCalled();
  });

  it('refuses when no invoker is registered in the process', async () => {
    vi.mocked(getAgentInvoker).mockReturnValue(null);
    expect(errorOf(await invoke_agent.handler(ARGS, parent()))).toMatch(
      /no agent invoker registered/,
    );
  });
});

describe('invoke_agent hand-off', () => {
  it('hands the child the owner, target, next depth, parent trace and thinking budget', async () => {
    outputOf(await invoke_agent.handler(ARGS, parent()));
    expect(invoker).toHaveBeenCalledTimes(1);
    expect(invoker).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'o1',
        agentSlug: 'researcher',
        depth: 2,
        parentTraceId: 'pt1',
        thinkingBudget: 2048,
      }),
    );
  });

  it('packs the subject ids and the verbatim user ask into the child prompt', async () => {
    outputOf(
      await invoke_agent.handler({ ...ARGS, subject_node_ids: ['n1', 7, '', 'n2'] }, parent()),
    );
    const prompt = invoker.mock.calls[0]![0].prompt;
    expect(prompt.startsWith(ARGS.prompt)).toBe(true);
    expect(prompt).toContain('delegation context (attached automatically by the runtime)');
    expect(prompt).toContain(
      'Subject node ids (operate on exactly these; do not search for others): n1, n2',
    );
    expect(prompt).toContain(USER_ASK);
  });

  it('does not double the user ask when the parent already quoted it', async () => {
    const quoted = `${ARGS.prompt}\n\nThe user said: ${USER_ASK}`;
    outputOf(await invoke_agent.handler({ ...ARGS, prompt: quoted }, parent()));
    const prompt = invoker.mock.calls[0]![0].prompt;
    expect(prompt).toBe(quoted);
    expect(prompt).not.toContain('verbatim message');
  });

  it('returns the child text and trace id, and records the cost on the step meta', async () => {
    const setMeta = vi.fn();
    const ctx = {
      ...parent(),
      step: { setMeta, setOutput: vi.fn() },
    };
    expect(outputOf(await invoke_agent.handler(ARGS, ctx))).toEqual({
      text: 'done',
      child_trace_id: 'ct1',
    });
    expect(setMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        child_trace_id: 'ct1',
        child_cost_micro_usd: 12,
        child_tokens_in: 3,
        child_tokens_out: 4,
        delegated_to: 'researcher',
      }),
    );
  });

  it('surfaces a child failure as a tool error', async () => {
    invoker.mockResolvedValue({ ok: false, error: 'model refused' });
    expect(errorOf(await invoke_agent.handler(ARGS, parent()))).toBe(
      'child agent failed: model refused',
    );
  });
});

// Client logins C4 (plan section 8): the child works for the parent's caller.
// A team turn must not reach owner-only tools by delegating, and an
// owner parent's child is the owner (as owner/delegate, not the chat channel).
describe('invoke_agent passes the caller down to the child', () => {
  const TEAM = { kind: 'team' as const, loginId: '00000000-0000-4000-8000-000000000002' };
  const cases: Array<[string, ToolHandlerContext['surface'], ToolHandlerContext['surface']]> = [
    ['web owner', { kind: 'web' }, { kind: 'owner', via: 'delegate' }],
    [
      'telegram owner',
      { kind: 'telegram', telegramChatId: '42' },
      { kind: 'owner', via: 'delegate' },
    ],
    ['mcp owner', { kind: 'owner', via: 'mcp' }, { kind: 'owner', via: 'delegate' }],
    ['team member', TEAM, TEAM],
    ['missing surface', undefined, undefined],
  ];
  it.each(cases)('%s', async (_name, surface, expected) => {
    // A team or missing surface is a workspace turn: a workspace delegate,
    // in a scope that answers the login.
    scope.open = { kind: 'assistant', loginId: TEAM.loginId, ws: ['w1'], modWs: [] };
    scope.holdsAdmin = false;
    const ctx = { ...parent({ delegateTo: ['presenter'], taint: newTurnTaint() }), surface };
    outputOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'presenter' }, ctx));
    const input = invoker.mock.calls[0]![0];
    expect(input.surface).toEqual(expected);
  });
});

// Owner decision 2026-10-26: a workspace turn delegates to the workspace
// delegates only (Draftsman, Presenter, Appsmith), in BOTH that list and
// its own allowlist, and only when it answers a login. One gateway: the
// handler asks checkDelegationAllowed with the turn read from its scope and
// surface, before any lookup or child turn.
describe('invoke_agent in a workspace turn', () => {
  const LOGIN = '00000000-0000-4000-8000-000000000003';
  const ALL = ['researcher', 'pages', 'toolsmith', 'coder', ...WORKSPACE_DELEGATE_SLUGS];
  const wsTurn = (over: Partial<NonNullable<ToolHandlerContext['agent']>> = {}) => {
    scope.open = { kind: 'assistant', loginId: LOGIN, ws: ['w1'], modWs: [] };
    scope.holdsAdmin = false;
    return {
      ...parent({ slug: 'ws-assistant', delegateTo: ALL, taint: newTurnTaint(), ...over }),
      surface: { kind: 'team' as const, loginId: LOGIN },
    };
  };

  it('the list is exactly Draftsman, Presenter and Appsmith', () => {
    expect([...WORKSPACE_DELEGATE_SLUGS]).toEqual(['diagrammer', 'presenter', 'appsmith']);
  });

  it.each(['researcher', 'pages', 'toolsmith', 'coder'])(
    'refuses %s even when the allowlist names it, before any lookup',
    async (slug) => {
      const err = errorOf(await invoke_agent.handler({ ...ARGS, agent_slug: slug }, wsTurn()));
      expect(err).toMatch(/cannot be delegated to from a workspace/);
      expect(err).toContain(`'${slug}'`);
      expect(invoker).not.toHaveBeenCalled();
      expect(dbmod.db.select).not.toHaveBeenCalled();
    },
  );

  it.each([...WORKSPACE_DELEGATE_SLUGS])(
    'hands %s the turn: next depth, the team surface',
    async (slug) => {
      outputOf(await invoke_agent.handler({ ...ARGS, agent_slug: slug }, wsTurn()));
      expect(invoker).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSlug: slug,
          depth: 2,
          surface: { kind: 'team', loginId: LOGIN },
        }),
      );
    },
  );

  it('a workspace delegate off the allowlist is still refused', async () => {
    const err = errorOf(
      await invoke_agent.handler(
        { ...ARGS, agent_slug: 'presenter' },
        wsTurn({ delegateTo: ['diagrammer'] }),
      ),
    );
    expect(err).toMatch(/not in the parent's delegation allowlist/);
    expect(invoker).not.toHaveBeenCalled();
  });

  it('a workspace turn that answers no login delegates nothing', async () => {
    const ctx = wsTurn();
    scope.open = { kind: 'assistant', loginId: null, ws: ['w1'], modWs: [] };
    const err = errorOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'presenter' }, ctx));
    expect(err).toMatch(/answers no user/);
    expect(invoker).not.toHaveBeenCalled();
  });

  it('nested: Appsmith to Toolsmith is refused in a workspace turn, before the terminal lookup', async () => {
    const err = errorOf(
      await invoke_agent.handler(
        { ...ARGS, agent_slug: 'toolsmith' },
        wsTurn({ slug: 'appsmith', depth: 2, delegateTo: ['toolsmith'] }),
      ),
    );
    expect(err).toMatch(/cannot be delegated to from a workspace/);
    expect(invoker).not.toHaveBeenCalled();
    expect(dbmod.db.select).not.toHaveBeenCalled();
  });

  // At most two successful delegations per workspace
  // turn, and none while the user's daily budget is below the floor.
  it('a third delegation in one workspace turn is refused; a failed child does not count', async () => {
    const ctx = wsTurn();
    outputOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'presenter' }, ctx));
    invoker.mockResolvedValueOnce({ ok: false, error: 'boom' });
    expect(errorOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'presenter' }, ctx))).toMatch(
      /child agent failed: boom/,
    );
    invoker.mockRejectedValueOnce(new Error('thrown'));
    await expect(invoke_agent.handler({ ...ARGS, agent_slug: 'presenter' }, ctx)).rejects.toThrow(
      'thrown',
    );
    outputOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'diagrammer' }, ctx));
    expect(invoker).toHaveBeenCalledTimes(4);
    expect(errorOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'appsmith' }, ctx))).toBe(
      WORKSPACE_DELEGATION_COUNT_ERROR,
    );
    expect(invoker).toHaveBeenCalledTimes(4);
    // Another turn counts on its own.
    outputOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'appsmith' }, wsTurn()));
  });

  it('an Admin turn is not counted', async () => {
    const ctx = parent({ taint: newTurnTaint() });
    for (let i = 0; i < 4; i++) outputOf(await invoke_agent.handler(ARGS, ctx));
    expect(invoker).toHaveBeenCalledTimes(4);
  });

  it('a workspace turn with no turn object is refused (fail closed)', async () => {
    const ctx = wsTurn({ taint: undefined });
    expect(errorOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'presenter' }, ctx))).toMatch(
      /names no turn/,
    );
    expect(invoker).not.toHaveBeenCalled();
  });

  it('below the token floor a workspace turn delegates nothing; no budget passes', async () => {
    const low = {
      ...wsTurn(),
      surface: {
        kind: 'team' as const,
        loginId: LOGIN,
        tokensLeft: WORKSPACE_DELEGATION_TOKEN_FLOOR - 1,
      },
    };
    expect(errorOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'presenter' }, low))).toBe(
      WORKSPACE_DELEGATION_BUDGET_ERROR,
    );
    expect(invoker).not.toHaveBeenCalled();
    const enough = {
      ...wsTurn(),
      surface: {
        kind: 'team' as const,
        loginId: LOGIN,
        tokensLeft: WORKSPACE_DELEGATION_TOKEN_FLOOR,
      },
    };
    outputOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'presenter' }, enough));
    outputOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'presenter' }, wsTurn()));
    expect(invoker).toHaveBeenCalledTimes(2);
  });

  it('the turn’s own tokens so far, and its children’s, count against what is left', async () => {
    const ctx = {
      ...wsTurn(),
      surface: {
        kind: 'team' as const,
        loginId: LOGIN,
        tokensLeft: WORKSPACE_DELEGATION_TOKEN_FLOOR + 19,
      },
    };
    trace.now = { tokens: { in: 8, out: 5 }, delegatedTokens: { in: 4, out: 3 } };
    expect(errorOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'presenter' }, ctx))).toBe(
      WORKSPACE_DELEGATION_BUDGET_ERROR,
    );
    trace.now = { tokens: { in: 8, out: 5 } };
    outputOf(await invoke_agent.handler({ ...ARGS, agent_slug: 'presenter' }, ctx));
    expect(invoker).toHaveBeenCalledTimes(1);
  });

  it('an owner surface in a scope without Admin is a workspace turn too', async () => {
    scope.open = { kind: 'assistant', loginId: LOGIN, ws: ['w1'], modWs: [] };
    scope.holdsAdmin = false;
    const ctx = {
      ...parent({ delegateTo: ALL }),
      surface: { kind: 'web' as const, loginId: LOGIN },
    };
    expect(errorOf(await invoke_agent.handler(ARGS, ctx))).toMatch(/from a workspace/);
    expect(invoker).not.toHaveBeenCalled();
  });

  it('an Admin turn (owner surface, a scope that holds Admin) keeps its whole allowlist', async () => {
    scope.open = { kind: 'assistant', loginId: LOGIN, ws: ['admin'], modWs: ['admin'] };
    scope.holdsAdmin = true;
    for (const slug of ['researcher', 'toolsmith', 'presenter']) {
      const ctx = {
        ...parent({ delegateTo: ALL }),
        surface: { kind: 'web' as const, loginId: LOGIN },
      };
      outputOf(await invoke_agent.handler({ ...ARGS, agent_slug: slug }, ctx));
    }
    expect(invoker).toHaveBeenCalledTimes(3);
  });
});

// Client logins C4 (plan N18): one client-sourced taint for the whole
// delegation tree, shared by reference.
describe('invoke_agent shares the turn taint with the child', () => {
  it('passes the very same taint object down', async () => {
    const taint = { clientSourced: true, via: 'task_get' };
    outputOf(await invoke_agent.handler(ARGS, parent({ taint })));
    expect(invoker.mock.calls[0]![0].taint).toBe(taint);
  });

  it('passes none when the parent has none', async () => {
    outputOf(await invoke_agent.handler(ARGS, parent()));
    expect(invoker.mock.calls[0]![0].taint).toBeUndefined();
  });
});
