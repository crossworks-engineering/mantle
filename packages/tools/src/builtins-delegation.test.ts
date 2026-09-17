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
  return { ...actual, db: { ...actual.db, select: vi.fn(() => chain) } };
});
vi.mock('./agent-bridge', () => ({ getAgentInvoker: vi.fn(), registerAgentInvoker: vi.fn() }));

import * as dbmod from '@mantle/db';
import { getAgentInvoker, type AgentInvoker } from './agent-bridge';
import { invoke_agent } from './builtins-delegation';
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
  it('refuses without parent agent context and names it as a wiring bug', async () => {
    expect(errorOf(await invoke_agent.handler(ARGS, { ownerId: 'o1' }))).toMatch(
      /missing parent agent context/,
    );
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
      step: { setMeta, setOutput: vi.fn(), addTokens: vi.fn(), addCost: vi.fn() },
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
