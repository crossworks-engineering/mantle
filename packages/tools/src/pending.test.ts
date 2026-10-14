/**
 * Unit tests for the pending-approval settle paths — the layer where an
 * operator's click becomes a runner-engine mutation. It had NO coverage until
 * now (the engine functions it composes are DB-tested; the routing, the
 * ownership hand-off and the failure recovery around them were not).
 *
 * The three things worth pinning:
 *   - Routing BEFORE tool resolution: `ask_human` / `run_budget` rows are
 *     engine-created surfaces, not registered tools, so they must branch out
 *     before anything tries to dispatch a tool by slug.
 *   - Ownership (final-audit F2): the row's owner is handed to the engine,
 *     which re-checks it against the run. A refusal must leave the row
 *     expired and enqueue nothing.
 *   - Recovery (final-audit F3): the row flips decided BEFORE the settle
 *     applies, so a failing settle must hand the decision BACK to the
 *     operator (status → pending) instead of stranding an "approved" that
 *     never took effect — for a budget pause that would otherwise leave the
 *     run paused with nothing left to approve.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  humanResult: {} as Record<string, unknown>,
  humanThrows: null as Error | null,
  budgetResult: {} as Record<string, unknown>,
  budgetThrows: null as Error | null,
  // Explicit call signatures rather than `ReturnType<typeof vi.fn>`: under
  // vitest 4 the bare form widens to `Mock<Procedure | Constructable>`, a union
  // that isn't callable (TS2348 at every `h.foo(...)` below).
  applyHumanAnswer: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  applyBudgetDecision: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  enqueueRunActionsSafe: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  dispatchTool: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  elevated: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  actors: [] as unknown[],
  elevatedRow: null as Record<string, unknown> | null,
  elevatedClaims: 0,
}));

vi.mock('drizzle-orm', () => {
  const tag = () => ({ __expr: true });
  return {
    and: tag,
    eq: tag,
    desc: tag,
    asc: tag,
    inArray: tag,
    sql: tag,
    isNull: tag,
    isNotNull: tag,
  };
});

vi.mock('@mantle/runs', () => ({
  applyHumanAnswer: (...a: unknown[]) => h.applyHumanAnswer(...a),
  applyBudgetDecision: (...a: unknown[]) => h.applyBudgetDecision(...a),
  budgetRunId: (args: Record<string, unknown> | null) =>
    typeof args?.['run_id'] === 'string' ? (args['run_id'] as string) : null,
  enqueueRunActionsSafe: (...a: unknown[]) => h.enqueueRunActionsSafe(...a),
  RUN_BUDGET_TOOL_SLUG: 'run_budget',
}));

vi.mock('./dispatch', () => ({ dispatchTool: (...a: unknown[]) => h.dispatchTool(...a) }));
vi.mock('./dispatch-bridge', () => ({
  dispatchViaBridge: (...a: unknown[]) => h.dispatchTool(...a),
}));
vi.mock('./pending-notify', () => ({ notifyPendingChanged: vi.fn(async () => {}) }));
// The approval rule (pending-approval.ts: its own tests): who decides is the
// login the path names, else the owner; an elevated call is judged by the
// stub `h.elevated` (it throws a refusal, or gives the run).
vi.mock('./pending-approval', () => {
  class ApprovalRefusedError extends Error {}
  return {
    ApprovalRefusedError,
    deciderOf: (ownerId: string, named?: string | null) => named ?? ownerId,
    isBrainOwner: (ownerId: string, login: string | null) => login === ownerId,
    elevatedApproval: (...a: unknown[]) => h.elevated(...a),
  };
});
vi.mock('@mantle/db', async () => ({
  db: new Proxy({}, { get: (_t, p: string) => (h.db as Record<string, unknown>)[p] }) as unknown,
  pendingToolCalls: { __table: 'pending_tool_calls' },
  tools: { __table: 'tools' },
  loginActorNow: async (loginId: string, _entry: string, mode = 'rw') => ({
    kind: 'login',
    mode,
    loginId,
  }),
  runAsActor: async (actor: unknown, fn: () => Promise<unknown>) => {
    h.actors.push(actor);
    return fn();
  },
  // The elevated call on the system pool (pending-elevated.ts).
  elevatedPendingCall: async () => h.elevatedRow,
  claimElevatedPendingCall: async () => {
    h.elevatedClaims += 1;
    return h.elevatedRow ? { ...h.elevatedRow, status: 'approved' } : null;
  },
}));
vi.mock('@mantle/tracing', () => ({
  startTrace: async (_i: unknown, fn: () => Promise<unknown>) => fn(),
  step: async (_i: unknown, fn: (handle: unknown) => Promise<unknown>) =>
    fn({ setMeta: () => {}, setOutput: () => {}, addTokens: () => {}, addCost: () => {} }),
}));

const { approvePendingCall, rejectPendingCall } = await import('./pending');

type Row = Record<string, unknown>;

/** Minimal drizzle-shaped double for the two chains this module uses:
 *  `update().set().where().returning()` and `select().from().where().limit()`.
 *  Deliberately local — a package must not reach into apps/ for test helpers,
 *  and the queries here are few enough that sharing would cost more than it
 *  saves. Reads consume queued batches, then repeat the last one (re-reading
 *  a row yields the same row, as a real database would). */
function makeFakeDb() {
  const queues = new Map<string, Row[][]>();
  const last = new Map<string, Row[]>();
  const writes: Array<{ table: string; values: Row }> = [];
  const nameOf = (t: unknown) => (t as { __table?: string })?.__table ?? 'unknown';
  const take = (table: string): Row[] => {
    const q = queues.get(table);
    if (q && q.length > 0) {
      const batch = q.shift()!;
      last.set(table, batch);
      return batch;
    }
    return last.get(table) ?? [];
  };
  const thenable = (produce: () => Row[]) => {
    const self: Record<string, unknown> = {
      then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve().then(produce).then(res, rej),
      where: () => self,
      limit: () => self,
      orderBy: () => self,
      returning: () => self,
    };
    return self;
  };
  const db = {
    select: (_f?: unknown) => ({ from: (t: unknown) => thenable(() => take(nameOf(t))) }),
    update: (t: unknown) => ({
      set: (values: Row) => {
        const table = nameOf(t);
        writes.push({ table, values });
        // RETURNING hands back the row AS UPDATED — modelling that is what
        // lets these tests assert on the summary a caller actually receives.
        return thenable(() => {
          const updated = take(table).map((r) => ({ ...r, ...values }));
          if (updated.length > 0) last.set(table, updated);
          return updated;
        });
      },
    }),
  };
  return {
    db,
    writes,
    queue: (table: string, ...batches: Row[][]) =>
      queues.set(table, [...(queues.get(table) ?? []), ...batches]),
  };
}
type FakeDb = ReturnType<typeof makeFakeDb>;

const OWNER = 'owner-1';
const ROW_ID = 'row-1';

function askRow(extra: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    ownerId: OWNER,
    toolSlug: 'ask_human',
    args: { question: 'Send it?', item_id: 'item-9', run_id: 'run-9' },
    status: 'approved',
    agentId: null,
    traceId: null,
    result: null,
    error: null,
    createdAt: new Date(),
    decidedAt: new Date(),
    executedAt: null,
    ...extra,
  };
}

function budgetRow(extra: Record<string, unknown> = {}) {
  return { ...askRow(), toolSlug: 'run_budget', args: { run_id: 'run-9' }, ...extra };
}

let fake: FakeDb;

beforeEach(() => {
  fake = makeFakeDb();
  h.db = fake.db as unknown as Record<string, unknown>;
  h.humanThrows = null;
  h.budgetThrows = null;
  h.humanResult = { ok: true, state: 'done', actions: [{ type: 'dispatch', itemId: 'next' }] };
  h.budgetResult = { ok: true, outcome: 'raised', newBudgetMicroUsd: 500_000, actions: [] };
  h.applyHumanAnswer = vi.fn(async () => {
    if (h.humanThrows) throw h.humanThrows;
    return h.humanResult;
  });
  h.applyBudgetDecision = vi.fn(async () => {
    if (h.budgetThrows) throw h.budgetThrows;
    return h.budgetResult;
  });
  h.enqueueRunActionsSafe = vi.fn(async () => {});
  h.dispatchTool = vi.fn(async () => ({ ok: true, output: {} }));
  h.elevated = vi.fn(async () => {
    throw new Error('not an elevated call');
  });
  h.actors = [];
  h.elevatedRow = null;
  h.elevatedClaims = 0;
});

/** Writes recorded against the pending table, newest last. */
const pendingWrites = () => fake.writes.filter((w) => w.table === 'pending_tool_calls');

describe('ask_human approvals', () => {
  it('passes the ROW OWNER to the engine and applies the free-text answer', async () => {
    fake.queue('pending_tool_calls', [askRow()]);
    await approvePendingCall(OWNER, ROW_ID, { answer: 'yes, send it' });
    expect(h.applyHumanAnswer).toHaveBeenCalledTimes(1);
    expect(h.applyHumanAnswer.mock.calls[0]![1]).toEqual({
      itemId: 'item-9',
      ownerId: OWNER,
      decision: 'answered',
      answer: 'yes, send it',
    });
    expect(h.enqueueRunActionsSafe).toHaveBeenCalledWith(h.humanResult.actions);
    expect(h.dispatchTool).not.toHaveBeenCalled(); // branched BEFORE tool resolution
  });

  it('treats a bare approval as the answer', async () => {
    fake.queue('pending_tool_calls', [askRow()]);
    await approvePendingCall(OWNER, ROW_ID);
    expect(h.applyHumanAnswer.mock.calls[0]![1]).toMatchObject({
      decision: 'answered',
      answer: undefined,
    });
  });

  it('forwards structured questionnaire answers and records them on the row', async () => {
    fake.queue('pending_tool_calls', [askRow()]);
    const answers = [
      { question: 'env', selected: ['prod'] },
      { question: 'window', selected: [], other: 'after 22:00 UTC' },
    ];
    await approvePendingCall(OWNER, ROW_ID, { answers });
    expect(h.applyHumanAnswer.mock.calls[0]![1]).toMatchObject({
      itemId: 'item-9',
      ownerId: OWNER,
      decision: 'answered',
      answers,
    });
    // The row keeps the structured record too — /pending shows what was
    // actually chosen, not just the prose the run consumed.
    const last = pendingWrites().at(-1)!;
    expect((last.values.result as Record<string, unknown>).answers).toEqual(answers);
  });

  it('omits an empty answers array rather than passing a meaningless one', async () => {
    fake.queue('pending_tool_calls', [askRow()]);
    await approvePendingCall(OWNER, ROW_ID, { answers: [] });
    expect(h.applyHumanAnswer.mock.calls[0]![1]).not.toHaveProperty('answers');
  });

  it('refuses a BARE approval of a questionnaire and hands it back', async () => {
    // The Telegram card (and pending_approve with no payload) can only say
    // "yes" — which would complete a 2-part form with the string 'approved'
    // and let the run continue having learned nothing.
    const form = {
      questions: [
        { id: 'env', question: 'Which env?' },
        { id: 'when', question: 'When?' },
      ],
    };
    fake.queue('pending_tool_calls', [
      askRow({ args: { question: 'Deploy?', item_id: 'item-9', form } }),
    ]);
    await approvePendingCall(OWNER, ROW_ID);
    expect(h.applyHumanAnswer).not.toHaveBeenCalled();
    const last = pendingWrites().at(-1)!;
    expect(last.values.status).toBe('pending'); // handed back, still answerable
    expect(last.values.decidedAt).toBeNull();
    expect(String(last.values.error)).toMatch(/2-part questionnaire/);
    expect(String(last.values.error)).toMatch(/\/pending/);
  });

  it('still lets a questionnaire through when answers ARE supplied', async () => {
    const form = { questions: [{ id: 'env', question: 'Which env?' }] };
    fake.queue('pending_tool_calls', [
      askRow({ args: { question: 'Deploy?', item_id: 'item-9', form } }),
    ]);
    await approvePendingCall(OWNER, ROW_ID, { answers: [{ question: 'env', selected: ['prod'] }] });
    expect(h.applyHumanAnswer).toHaveBeenCalledTimes(1);
  });

  it('still lets a bare approval through for a PLAIN question', async () => {
    fake.queue('pending_tool_calls', [askRow()]); // no form
    await approvePendingCall(OWNER, ROW_ID);
    expect(h.applyHumanAnswer).toHaveBeenCalledTimes(1);
  });

  it('rejection of a questionnaire is still allowed (declining IS an answer)', async () => {
    const form = { questions: [{ id: 'env', question: 'Which env?' }] };
    fake.queue('pending_tool_calls', [
      askRow({ status: 'rejected', args: { question: 'Deploy?', item_id: 'item-9', form } }),
    ]);
    h.humanResult = { ok: true, state: 'failed', actions: [] };
    await rejectPendingCall(OWNER, ROW_ID);
    expect(h.applyHumanAnswer).toHaveBeenCalledTimes(1);
    expect(h.applyHumanAnswer.mock.calls[0]![1]).toMatchObject({ decision: 'rejected' });
  });

  it('rejection completes the step so the run advances', async () => {
    fake.queue('pending_tool_calls', [askRow({ status: 'rejected' })]);
    h.humanResult = { ok: true, state: 'failed', actions: [] };
    await rejectPendingCall(OWNER, ROW_ID);
    expect(h.applyHumanAnswer.mock.calls[0]![1]).toMatchObject({ decision: 'rejected' });
  });

  it('expires the row when the run already moved on', async () => {
    fake.queue('pending_tool_calls', [askRow()]);
    h.humanResult = { ok: false, reason: 'moved_on', error: 'the run moved on' };
    const res = await approvePendingCall(OWNER, ROW_ID);
    expect(res?.status).toBe('expired');
    expect(pendingWrites().at(-1)!.values).toMatchObject({ status: 'expired' });
    expect(h.enqueueRunActionsSafe).not.toHaveBeenCalled();
  });

  it('refuses a row whose run belongs to someone else (F2) without side effects', async () => {
    fake.queue('pending_tool_calls', [askRow()]);
    h.humanResult = { ok: false, reason: 'forbidden', error: 'not this owner' };
    const res = await approvePendingCall(OWNER, ROW_ID);
    expect(res?.status).toBe('expired');
    expect(h.enqueueRunActionsSafe).not.toHaveBeenCalled();
  });

  it('records an error when the row carries no item ref', async () => {
    fake.queue('pending_tool_calls', [askRow({ args: { question: 'orphan' } })]);
    await approvePendingCall(OWNER, ROW_ID);
    expect(h.applyHumanAnswer).not.toHaveBeenCalled();
    expect(pendingWrites().at(-1)!.values.error).toMatch(/no item_id ref/);
  });

  it('hands the decision back when the settle FAILS mid-way (F3)', async () => {
    fake.queue('pending_tool_calls', [askRow()]);
    h.humanThrows = new Error('connection terminated');
    const res = await approvePendingCall(OWNER, ROW_ID);
    // Not left as a phantom "approved": the operator can decide again.
    expect(res?.status).toBe('pending');
    const last = pendingWrites().at(-1)!.values;
    expect(last).toMatchObject({ status: 'pending', decidedAt: null });
    expect(String(last.error)).toMatch(/did not apply/);
    expect(h.enqueueRunActionsSafe).not.toHaveBeenCalled();
  });
});

describe('run_budget decisions', () => {
  it('approval raises the budget and resumes', async () => {
    fake.queue('pending_tool_calls', [budgetRow()]);
    const res = await approvePendingCall(OWNER, ROW_ID);
    expect(h.applyBudgetDecision.mock.calls[0]![1]).toEqual({
      runId: 'run-9',
      ownerId: OWNER,
      decision: 'raise',
    });
    expect(res?.result).toMatchObject({ outcome: 'raised', new_budget_micro_usd: 500_000 });
  });

  it('rejection cancels the run', async () => {
    fake.queue('pending_tool_calls', [budgetRow({ status: 'rejected' })]);
    h.budgetResult = { ok: true, outcome: 'cancelled' };
    await rejectPendingCall(OWNER, ROW_ID);
    expect(h.applyBudgetDecision.mock.calls[0]![1]).toMatchObject({ decision: 'cancel' });
  });

  it('expires a moot question when the run is no longer paused', async () => {
    fake.queue('pending_tool_calls', [budgetRow()]);
    h.budgetResult = { ok: false, reason: 'not_paused', error: 'no longer paused' };
    const res = await approvePendingCall(OWNER, ROW_ID);
    expect(res?.status).toBe('expired');
  });

  it('hands a failed raise back to the operator rather than stranding the pause (F3)', async () => {
    fake.queue('pending_tool_calls', [budgetRow()]);
    h.budgetThrows = new Error('deadlock detected');
    const res = await approvePendingCall(OWNER, ROW_ID);
    expect(res?.status).toBe('pending');
    expect(pendingWrites().at(-1)!.values).toMatchObject({ status: 'pending', decidedAt: null });
  });
});

describe('claim semantics', () => {
  it('returns null for an already-decided row and settles nothing', async () => {
    fake.queue('pending_tool_calls', []); // the CAS matched no pending row
    const res = await approvePendingCall(OWNER, ROW_ID);
    expect(res).toBeNull();
    expect(h.applyHumanAnswer).not.toHaveBeenCalled();
    expect(h.applyBudgetDecision).not.toHaveBeenCalled();
  });
});

describe('a tool call approved (W6b fix round 3, L-2)', () => {
  const toolRow = () => ({ ...askRow(), toolSlug: 'app_delete', args: { id: 'app-1' } });
  const surfaceOf = () =>
    (h.dispatchTool.mock.calls[0]![2] as { surface: Record<string, unknown> }).surface;

  it('runs naming its approver, so the owner deletes as the owner', async () => {
    fake.queue('pending_tool_calls', [toolRow()]);
    fake.queue('tools', [{ slug: 'app_delete', ownerId: OWNER, enabled: true }]);
    await approvePendingCall(OWNER, ROW_ID, { approverLoginId: 'login-a' });
    expect(surfaceOf()).toEqual({ kind: 'owner', via: 'pending', loginId: 'login-a' });
  });

  it('names no login when the path names none (held for the owner)', async () => {
    fake.queue('pending_tool_calls', [toolRow()]);
    fake.queue('tools', [{ slug: 'app_delete', ownerId: OWNER, enabled: true }]);
    await approvePendingCall(OWNER, ROW_ID);
    expect(surfaceOf()).toEqual({ kind: 'owner', via: 'pending' });
  });
});

describe('an elevated call: the approval rule decides before the claim (A5 step 6d fix round 1)', () => {
  const elevRow = (extra: Record<string, unknown> = {}) => ({
    ...askRow(),
    status: 'pending',
    toolSlug: 'crm_update',
    args: { id: 'c-1' },
    loginId: 'login-asker',
    workspaceId: 'ws-team',
    elevated: { elevated: true, reason: 'r' },
    ...extra,
  });
  const queueElevated = () => {
    // The plain claim matches nothing (the row is elevated); the system
    // pool's read finds it, its claim takes it.
    fake.queue('pending_tool_calls', []);
    h.elevatedRow = elevRow();
    fake.queue('tools', [{ slug: 'crm_update', ownerId: OWNER, enabled: true }]);
  };

  it('a refused approver: the refusal is thrown and the call is never claimed', async () => {
    queueElevated();
    const { ApprovalRefusedError } = await import('./pending-approval');
    h.elevated = vi.fn(async () => {
      throw new ApprovalRefusedError('you asked for it');
    });
    await expect(
      approvePendingCall(OWNER, ROW_ID, { approverLoginId: 'login-asker' }),
    ).rejects.toThrow('you asked for it');
    // Only the plain claim was tried (it matched nothing); no dispatch.
    expect(h.elevatedClaims).toBe(0);
    expect(h.dispatchTool).not.toHaveBeenCalled();
    expect(h.elevated.mock.calls[0]![3]).toBe('login-asker');
  });

  it("a passed approver: the call runs with the approver's rights, through the caller the rule gave", async () => {
    queueElevated();
    const caller = { entry: 'pending', via: 'process', approval: { approver: 'login-mod' } };
    h.elevated = vi.fn(async () => ({ caller, runAs: 'login-mod', owner: false }));
    await approvePendingCall(OWNER, ROW_ID, { approverLoginId: 'login-mod' });
    expect(h.elevatedClaims).toBe(1);
    expect(h.dispatchTool).toHaveBeenCalledTimes(1);
    expect((h.dispatchTool.mock.calls[0]![2] as { caller: unknown }).caller).toBe(caller);
    expect(h.actors).toEqual([{ kind: 'login', mode: 'rw', loginId: 'login-mod' }]);
  });

  it("the owner: the call runs with the owner's rights", async () => {
    queueElevated();
    const caller = { entry: 'pending', via: 'process', approval: { approver: OWNER } };
    h.elevated = vi.fn(async () => ({ caller, runAs: OWNER, owner: true }));
    await approvePendingCall(OWNER, ROW_ID);
    expect(h.actors).toEqual([{ kind: 'login', mode: 'owner', loginId: OWNER }]);
  });

  it('any other call keeps its rule: run as its asker, naming the approver for its audit row', async () => {
    fake.queue('pending_tool_calls', [{ ...elevRow({ status: 'approved' }), elevated: null }]);
    fake.queue('tools', [{ slug: 'crm_update', ownerId: OWNER, enabled: true }]);
    await approvePendingCall(OWNER, ROW_ID, { approverLoginId: 'login-a' });
    expect(h.elevated).not.toHaveBeenCalled();
    expect(h.actors).toEqual([{ kind: 'login', mode: 'rw', loginId: 'login-asker' }]);
    const caller = (h.dispatchTool.mock.calls[0]![2] as { caller: Record<string, unknown> }).caller;
    expect(caller).toMatchObject({ entry: 'pending', approval: { approver: 'login-a' } });
  });
});
