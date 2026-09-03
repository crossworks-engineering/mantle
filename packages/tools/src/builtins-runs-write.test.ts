/**
 * Behavioural tests for the run WRITE tools: run_plan, run_append,
 * run_cancel, run_audit. `builtins-runs.test.ts` covers the parser
 * (parsePlan) and the item ban list; nothing exercised the handlers.
 *
 * What is worth pinning, in order of blast radius:
 *
 *  - Ownership. Every tool resolves the run through `loadOwnedRun`, whose
 *    WHERE carries the caller's owner id. Drop that clause and any owner can
 *    cancel, extend or adjudicate another owner's run by id. The where
 *    clause is a real drizzle SQL object, so the tests walk its bound
 *    params rather than mocking drizzle away.
 *  - The depth guard. A delegated child agent (depth > 1) is refused by every
 *    run tool BEFORE anything else, including the feature flag. A worker
 *    that could cancel the run it is a step of would be a self-inflicted
 *    denial of service.
 *  - Guards fire before the engine. A disabled brain, a bad plan, an unknown
 *    tool or an unknown worker must leave `createRun` / `appendChildren`
 *    untouched, otherwise the run exists with a dead item in it.
 *  - run_cancel is idempotent: a finished run reports cancelled=false as a
 *    SUCCESS, not an error, so a retrying caller does not flail.
 *  - run_audit: the audit item must belong to the named run, findings are
 *    filtered to the two severities, and an engine refusal enqueues nothing.
 *
 * The engine (@mantle/runs) is stubbed at its exported functions; the db
 * select chain is a queue of result batches consumed in call order.
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
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
      Promise.resolve(selectQueue.shift() ?? []).then(res, rej),
  };
  return { ...actual, db: { ...actual.db, select: vi.fn(() => chain) } };
});
vi.mock('@mantle/runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/runs')>();
  return {
    ...actual,
    isRunsEnabled: vi.fn(),
    createRun: vi.fn(),
    appendChildren: vi.fn(),
    cancelRun: vi.fn(),
    applyAuditVerdict: vi.fn(),
    compileRunState: vi.fn(),
    renderRunStateText: vi.fn(),
    enqueueRunActionsSafe: vi.fn(),
    listWorkerAgents: vi.fn(),
    ensureWorkerAgent: vi.fn(),
  };
});
vi.mock('./resolve', () => ({ resolveTool: vi.fn(), resolveTools: vi.fn() }));

import * as dbmod from '@mantle/db';
import {
  appendChildren,
  applyAuditVerdict,
  cancelRun,
  compileRunState,
  createRun,
  enqueueRunActionsSafe,
  ensureWorkerAgent,
  isRunsEnabled,
  ItemCapError,
  listWorkerAgents,
  renderRunStateText,
  SealedGroupError,
} from '@mantle/runs';
import { resolveTools } from './resolve';
import { RUN_TOOLS } from './builtins-runs';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const plan = RUN_TOOLS.find((t) => t.slug === 'run_plan')!;
const append = RUN_TOOLS.find((t) => t.slug === 'run_append')!;
const cancel = RUN_TOOLS.find((t) => t.slug === 'run_cancel')!;
const audit = RUN_TOOLS.find((t) => t.slug === 'run_audit')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
/** A delegated child agent: depth 2 is the first level below the responder. */
const delegated: ToolHandlerContext = {
  ownerId: 'o1',
  agent: { slug: 'worker', depth: 2, delegateTo: [] },
};

const RUN = { id: 'r1', ownerId: 'o1', rootItemId: 'root1', status: 'running' };

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

/** Bound parameter values of a drizzle SQL tree, in order. `eq(col, 'x')`
 *  contributes 'x'; `and(a, b)` nests. Owner scoping shows up here as the
 *  owner id being one of the params of the run lookup. */
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const o = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
  if (Array.isArray(o.queryChunks)) for (const c of o.queryChunks) paramsOf(c, out);
  else if ('value' in o && 'encoder' in o) out.push(o.value);
  return out;
}

/** The params of the FIRST select's where clause: the run lookup. */
function runLookupParams(): unknown[] {
  return paramsOf(whereArgs[0]);
}

const okPlan = {
  kind: 'seq',
  children: [
    { kind: 'note', text: 'plan' },
    { kind: 'tool_call', tool: 'search', args: { q: 'x' } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  whereArgs.length = 0;
  vi.mocked(isRunsEnabled).mockReturnValue(true);
  vi.mocked(resolveTools).mockResolvedValue([{ slug: 'search' }] as never);
  vi.mocked(listWorkerAgents).mockResolvedValue([] as never);
  vi.mocked(ensureWorkerAgent).mockResolvedValue({ id: 'w-default', slug: 'worker' } as never);
  vi.mocked(createRun).mockResolvedValue({
    runId: 'r1',
    rootItemId: 'root1',
    actions: [{ type: 'dispatch', itemId: 'i1' }],
  } as never);
  vi.mocked(appendChildren).mockResolvedValue({ itemIds: ['i9'], actions: [] } as never);
  vi.mocked(cancelRun).mockResolvedValue({ cancelled: true });
  vi.mocked(applyAuditVerdict).mockResolvedValue({
    ok: true,
    outcome: 'pass',
    actions: [{ type: 'dispatch', itemId: 'next' }],
  } as never);
  vi.mocked(compileRunState).mockResolvedValue({ run: RUN } as never);
  vi.mocked(renderRunStateText).mockReturnValue('Run "Digest" — status: running');
  vi.mocked(enqueueRunActionsSafe).mockResolvedValue(undefined);
});

describe('run_plan', () => {
  it('refuses a delegated agent before consulting anything else', async () => {
    const res = await plan.handler({ title: 'Digest', plan: okPlan }, delegated);
    expect(errorOf(res)).toMatch(/responder-only/);
    expect(isRunsEnabled).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it('refuses when runner queues are dark, naming the flag', async () => {
    vi.mocked(isRunsEnabled).mockReturnValue(false);
    const res = await plan.handler({ title: 'Digest', plan: okPlan }, ctx);
    expect(errorOf(res)).toMatch(/MANTLE_RUNS/);
    expect(createRun).not.toHaveBeenCalled();
  });

  it('rejects a non-positive budget and a blank title without creating anything', async () => {
    expect(
      errorOf(await plan.handler({ title: 'Digest', plan: okPlan, budget_usd: 0 }, ctx)),
    ).toMatch(/budget_usd must be a positive/);
    expect(errorOf(await plan.handler({ title: '  ', plan: okPlan }, ctx))).toMatch(
      /title is required/,
    );
    expect(createRun).not.toHaveBeenCalled();
  });

  it('surfaces a parser error and never reaches the engine', async () => {
    const res = await plan.handler(
      { title: 'Digest', plan: { kind: 'tool_call', tool: 'search' } },
      ctx,
    );
    expect(errorOf(res)).toMatch(/root must be a 'seq' or 'par'/);
    expect(resolveTools).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it('refuses a plan naming a tool the owner cannot call, checked under the owner', async () => {
    vi.mocked(resolveTools).mockResolvedValue([] as never);
    const res = await plan.handler(
      {
        title: 'Digest',
        plan: { kind: 'seq', children: [{ kind: 'tool_call', tool: 'ghost_tool' }] },
      },
      ctx,
    );
    // A dead item later would fail headless; the teaching error comes now.
    expect(errorOf(res)).toMatch(/unknown or disabled tool\(s\) in plan: ghost_tool/);
    expect(resolveTools).toHaveBeenCalledWith('o1', ['ghost_tool']);
    expect(createRun).not.toHaveBeenCalled();
  });

  it('refuses an unknown worker slug and lists the enabled ones', async () => {
    vi.mocked(listWorkerAgents).mockResolvedValue([{ id: 'w1', slug: 'researcher' }] as never);
    const res = await plan.handler(
      {
        title: 'Digest',
        plan: { kind: 'seq', children: [{ kind: 'worker_invoke', step: 'do', worker: 'nope' }] },
      },
      ctx,
    );
    expect(errorOf(res)).toMatch(/unknown worker 'nope'/);
    expect(errorOf(res)).toMatch(/researcher/);
    expect(listWorkerAgents).toHaveBeenCalledWith(expect.anything(), 'o1');
    expect(createRun).not.toHaveBeenCalled();
  });

  it('routes a worker step with no explicit worker to the default worker', async () => {
    await plan.handler(
      { title: 'Digest', plan: { kind: 'seq', children: [{ kind: 'worker_invoke', step: 'do' }] } },
      ctx,
    );
    expect(ensureWorkerAgent).toHaveBeenCalledWith(expect.anything(), 'o1');
    const opts = vi.mocked(createRun).mock.calls[0]![1] as {
      plan: { children: Array<{ agentId?: string }> };
    };
    expect(opts.plan.children[0]!.agentId).toBe('w-default');
  });

  it('creates the run under the owner, in micro-USD, and enqueues its first actions', async () => {
    const step = { setMeta: vi.fn(), setOutput: vi.fn(), addTokens: vi.fn(), addCost: vi.fn() };
    const res = await plan.handler(
      { title: ' Digest ', plan: okPlan, budget_usd: 0.5 },
      {
        ...ctx,
        step,
      },
    );
    expect(createRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerId: 'o1', title: 'Digest', budgetMicroUsd: 500_000 }),
    );
    expect(enqueueRunActionsSafe).toHaveBeenCalledWith([{ type: 'dispatch', itemId: 'i1' }]);
    expect(outputOf(res)).toMatchObject({ run_id: 'r1', root_item_id: 'root1' });
    expect(outputOf(res).state).toMatch(/Digest/);
    // The trace step carries the run id so the run view can be reached from
    // the turn that created it.
    expect(step.setMeta).toHaveBeenCalledWith({ run_id: 'r1' });
  });

  it('remembers a Telegram origin so the final report returns to that chat', async () => {
    await plan.handler(
      { title: 'Digest', plan: okPlan },
      {
        ...ctx,
        surface: { kind: 'telegram', telegramChatId: '555' },
      },
    );
    const opts = vi.mocked(createRun).mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.originChannel).toEqual({ kind: 'telegram', chat_id: '555' });
  });

  it('turns an item-cap refusal into a teaching error instead of a throw', async () => {
    vi.mocked(createRun).mockRejectedValue(new ItemCapError(50, 51));
    const res = await plan.handler({ title: 'Digest', plan: okPlan }, ctx);
    expect(errorOf(res)).toMatch(/over its cap of 50/);
    expect(enqueueRunActionsSafe).not.toHaveBeenCalled();
  });
});

describe('run_append', () => {
  const children = [{ kind: 'note', text: 'more' }];
  const GROUP = { id: 'root1', runId: 'r1', kind: 'group_seq' };

  it('refuses a delegated agent and a dark brain without a lookup', async () => {
    expect(errorOf(await append.handler({ run_id: 'r1', children }, delegated))).toMatch(
      /responder-only/,
    );
    vi.mocked(isRunsEnabled).mockReturnValue(false);
    expect(errorOf(await append.handler({ run_id: 'r1', children }, ctx))).toMatch(/MANTLE_RUNS/);
    expect(dbmod.db.select).not.toHaveBeenCalled();
  });

  it('looks the run up under the caller and reports a miss with run_state', async () => {
    selectQueue.push([]);
    const res = await append.handler({ run_id: 'r1', children }, ctx);
    expect(errorOf(res)).toMatch(/run r1 not found/);
    expect(errorOf(res)).toMatch(/run_state/);
    expect(runLookupParams()).toEqual(['r1', 'o1']);
    expect(appendChildren).not.toHaveBeenCalled();
  });

  it('requires a non-empty children array', async () => {
    selectQueue.push([RUN]);
    const res = await append.handler({ run_id: 'r1', children: [] }, ctx);
    expect(errorOf(res)).toMatch(/children is required/);
    expect(appendChildren).not.toHaveBeenCalled();
  });

  it("refuses a group that belongs to a different run, even when the run is the caller's", async () => {
    selectQueue.push([RUN], [{ id: 'g-other', runId: 'r-other', kind: 'group_seq' }]);
    const res = await append.handler({ run_id: 'r1', group_id: 'g-other', children }, ctx);
    expect(errorOf(res)).toMatch(/run group g-other not found/);
    expect(appendChildren).not.toHaveBeenCalled();
  });

  it('refuses an audit appended into a par group, before the engine sees it', async () => {
    selectQueue.push([RUN], [{ id: 'p1', runId: 'r1', kind: 'group_par' }]);
    const res = await append.handler(
      { run_id: 'r1', group_id: 'p1', children: [{ kind: 'audit' }] },
      ctx,
    );
    // The parser saw a throwaway seq wrapper and let the audit through; the
    // real target is par, where an audit could never drive a redo.
    expect(errorOf(res)).toMatch(/par group/);
    expect(appendChildren).not.toHaveBeenCalled();
  });

  it('defaults to the root group and returns the new item ids', async () => {
    selectQueue.push([RUN], [GROUP]);
    const res = await append.handler({ run_id: 'r1', children }, ctx);
    expect(appendChildren).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        groupId: 'root1',
        children: [{ kind: 'note', payload: { text: 'more' } }],
      }),
    );
    expect(outputOf(res)).toEqual({ item_ids: ['i9'] });
  });

  it('teaches the fix when the group is sealed', async () => {
    selectQueue.push([RUN], [GROUP]);
    vi.mocked(appendChildren).mockRejectedValue(new SealedGroupError('root1'));
    const res = await append.handler({ run_id: 'r1', children }, ctx);
    expect(errorOf(res)).toMatch(/sealed/);
    expect(errorOf(res)).toMatch(/run_plan/);
    expect(enqueueRunActionsSafe).not.toHaveBeenCalled();
  });
});

describe('run_cancel', () => {
  it('refuses a delegated agent: a worker must never cancel the run it is a step of', async () => {
    const res = await cancel.handler({ run_id: 'r1' }, delegated);
    expect(errorOf(res)).toMatch(/responder-only/);
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the caller and cancels nothing on a miss', async () => {
    selectQueue.push([]);
    const res = await cancel.handler({ run_id: 'r1' }, ctx);
    expect(errorOf(res)).toMatch(/run r1 not found/);
    expect(runLookupParams()).toEqual(['r1', 'o1']);
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it('skips the lookup entirely for a blank id', async () => {
    const res = await cancel.handler({ run_id: '  ' }, ctx);
    expect(errorOf(res)).toMatch(/not found/);
    expect(dbmod.db.select).not.toHaveBeenCalled();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it('cancels by the resolved run id', async () => {
    selectQueue.push([RUN]);
    const res = await cancel.handler({ run_id: ' r1 ' }, ctx);
    expect(cancelRun).toHaveBeenCalledWith(expect.anything(), 'r1');
    expect(outputOf(res)).toEqual({ run_id: 'r1', cancelled: true });
  });

  it('reports an already-finished run as cancelled=false, not as an error', async () => {
    selectQueue.push([{ ...RUN, status: 'completed' }]);
    vi.mocked(cancelRun).mockResolvedValue({ cancelled: false });
    const res = await cancel.handler({ run_id: 'r1' }, ctx);
    // Idempotent by contract: a retrying caller must not read this as a
    // failure and loop.
    expect(outputOf(res)).toEqual({ run_id: 'r1', cancelled: false });
  });
});

describe('run_audit', () => {
  const ITEM = { id: 'a1', runId: 'r1' };

  it('refuses a delegated agent without a lookup', async () => {
    const res = await audit.handler(
      { run_id: 'r1', audit_item_id: 'a1', verdict: 'pass' },
      delegated,
    );
    expect(errorOf(res)).toMatch(/responder-only/);
    expect(dbmod.db.select).not.toHaveBeenCalled();
  });

  it('looks the run up under the caller', async () => {
    selectQueue.push([]);
    const res = await audit.handler({ run_id: 'r1', audit_item_id: 'a1', verdict: 'pass' }, ctx);
    expect(errorOf(res)).toMatch(/run r1 not found/);
    expect(runLookupParams()).toEqual(['r1', 'o1']);
    expect(applyAuditVerdict).not.toHaveBeenCalled();
  });

  it('refuses an audit item that is not in the named run', async () => {
    selectQueue.push([RUN], [{ id: 'a1', runId: 'r-other' }]);
    const res = await audit.handler({ run_id: 'r1', audit_item_id: 'a1', verdict: 'pass' }, ctx);
    // Without this a caller could adjudicate an item of another run by
    // naming any run they own.
    expect(errorOf(res)).toMatch(/audit item a1 not found/);
    expect(applyAuditVerdict).not.toHaveBeenCalled();
  });

  it('rejects a verdict outside pass/redo', async () => {
    selectQueue.push([RUN], [ITEM]);
    const res = await audit.handler({ run_id: 'r1', audit_item_id: 'a1', verdict: 'maybe' }, ctx);
    expect(errorOf(res)).toMatch(/verdict must be 'pass' or 'redo'/);
    expect(applyAuditVerdict).not.toHaveBeenCalled();
  });

  it('forwards only well-formed findings and the trimmed directive', async () => {
    selectQueue.push([RUN], [ITEM]);
    const res = await audit.handler(
      {
        run_id: 'r1',
        audit_item_id: 'a1',
        verdict: 'pass',
        directive: '  ship it  ',
        findings: [
          { severity: 'advisory', claim: ' typo in title ', suggested_fix: 'fix it' },
          { severity: 'fatal', claim: 'not a real severity' },
          { severity: 'blocking', claim: '   ' },
          null,
        ],
      },
      ctx,
    );
    expect(applyAuditVerdict).toHaveBeenCalledWith(expect.anything(), {
      auditItemId: 'a1',
      verdict: 'pass',
      findings: [{ severity: 'advisory', claim: 'typo in title', suggested_fix: 'fix it' }],
      directive: 'ship it',
    });
    expect(enqueueRunActionsSafe).toHaveBeenCalledWith([{ type: 'dispatch', itemId: 'next' }]);
    expect(outputOf(res)).toMatchObject({ outcome: 'pass' });
    expect(outputOf(res).replacement_item_id).toBeUndefined();
  });

  it('reports a redo with the replacement item and tells the caller to end the turn', async () => {
    selectQueue.push([RUN], [ITEM]);
    vi.mocked(applyAuditVerdict).mockResolvedValue({
      ok: true,
      outcome: 'redo',
      replacementItemId: 'w2',
      actions: [],
    } as never);
    const res = await audit.handler(
      {
        run_id: 'r1',
        audit_item_id: 'a1',
        verdict: 'redo',
        findings: [{ severity: 'blocking', claim: 'wrong file' }],
      },
      ctx,
    );
    expect(outputOf(res)).toMatchObject({ outcome: 'redo', replacement_item_id: 'w2' });
    expect(String(outputOf(res).message)).toMatch(/Redo appended/);
  });

  it('surfaces an engine refusal and enqueues nothing', async () => {
    selectQueue.push([RUN], [ITEM]);
    vi.mocked(applyAuditVerdict).mockResolvedValue({
      ok: false,
      error: 'redo needs a blocking finding',
    } as never);
    const res = await audit.handler({ run_id: 'r1', audit_item_id: 'a1', verdict: 'redo' }, ctx);
    expect(errorOf(res)).toBe('redo needs a blocking finding');
    expect(enqueueRunActionsSafe).not.toHaveBeenCalled();
  });
});
