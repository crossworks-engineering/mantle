/**
 * Unit tests for the runs WORKER turn workflow (slice 3 WP1 + the v0.157.14
 * replay hardening). Same posture as the resume-turn suite: the model loop,
 * the engine and key resolution are mocked; what is pinned here is the
 * workflow's own decisions.
 *
 * Highlights:
 *   - REPLAY (final-audit F4): after a crash following the journaled
 *     `complete_item`, recovery must still re-emit the RECORDED post-commit
 *     actions. Before the fix the stale-check was unjournaled glue: on replay
 *     it re-read the (now terminal) item, exited 'stale', and the recorded
 *     dispatch/resume actions were silently dropped — the run limped on the
 *     sweep instead of the engine's own choreography.
 *   - Flag discipline across runtimes: with MANTLE_RUNS off in apps/api the
 *     item is completed `failed(disabled)` rather than left to rot.
 *   - Route inheritance, the mechanical evidence ledger, and the
 *     retry-then-fail policy.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { makeFakeDb, makeJournal, type FakeDb, type Journal } from './workflow-test-kit';

const h = vi.hoisted(() => ({
  journal: null as unknown as {
    runStep: (fn: () => Promise<unknown>, o: { name: string }) => unknown;
  },
  db: null as unknown as Record<string, unknown>,
  runsEnabled: true,
  worker: null as unknown,
  keyOk: true,
  adapter: { providerId: 'openrouter' } as unknown,
  loopResult: null as unknown,
  loopThrows: null as Error | null,
  // Widened: individual tests swap in other action shapes (e.g. a
  // `pending_created` notice) to exercise the emit split.
  completeResult: {
    completed: true,
    actions: [{ type: 'resume', runId: 'run-1', groupId: 'g1' }],
  } as {
    completed: boolean;
    actions: Array<Record<string, unknown>>;
  },
  // Explicit call signatures rather than `ReturnType<typeof vi.fn>`: under
  // vitest 4 the bare form widens to `Mock<Procedure | Constructable>`, a union
  // that isn't callable (TS2348 at every call site below).
  completeItem: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  enqueueRunJobsSafe: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  runPendingNotices: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  requeueForRetry: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  spillToolResult: null as unknown as Mock<(...a: unknown[]) => Promise<unknown>>,
  logs: [] as Array<{ level: string; message: string }>,
}));

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    registerWorkflow: <T>(fn: T) => fn,
    runStep: (fn: () => Promise<unknown>, o: { name: string }) => h.journal.runStep(fn, o),
    span: undefined,
    logger: {
      info: (m: string) => h.logs.push({ level: 'info', message: m }),
      warn: (m: string) => h.logs.push({ level: 'warn', message: m }),
      error: (m: string) => h.logs.push({ level: 'error', message: m }),
    },
  },
}));

vi.mock('drizzle-orm', () => {
  const tag = () => ({ __expr: true });
  return { and: tag, eq: tag, inArray: tag, isNull: tag, lt: tag, asc: tag, desc: tag, sql: tag };
});

vi.mock('@mantle/db', () => ({
  db: new Proxy({}, { get: (_t, p: string) => (h.db as Record<string, unknown>)[p] }) as unknown,
  runItems: { __table: 'run_items' },
  runs: { __table: 'runs' },
  agents: { __table: 'agents' },
  bumpAgentUsage: vi.fn(async () => {}),
}));

vi.mock('@mantle/runs', () => ({
  isRunsEnabled: () => h.runsEnabled,
  completeItem: (...a: unknown[]) => h.completeItem(...a),
  enqueueRunJobsSafe: (...a: unknown[]) => h.enqueueRunJobsSafe(...a),
  runPendingNotices: (...a: unknown[]) => h.runPendingNotices(...a),
  requeueForRetry: (...a: unknown[]) => h.requeueForRetry(...a),
  ensureWorkerAgent: async () => h.worker,
  WORKER_MODEL_INHERIT: 'inherit',
  RUNS_WORKER_TURN_WORKFLOW: 'runsWorkerTurnWorkflow',
}));

vi.mock('@mantle/agent-runtime', () => ({
  composeSystemPromptWithSkills: (p: string) => p ?? 'sys',
  effectiveToolSlugs: () => [],
  resolveAgentSkills: async () => [],
  resolveAgentToolGroups: async () => [],
  resolveAgentTools: async () => [],
  resolveBackupAdapter: async () => null,
  resolveChatKey: async () => (h.keyOk ? { ok: true, apiKey: 'sk-test' } : { ok: false }),
  runToolLoop: async () => {
    if (h.loopThrows) throw h.loopThrows;
    return h.loopResult;
  },
}));

vi.mock('@mantle/tools', () => ({ spillToolResult: (...a: unknown[]) => h.spillToolResult(...a) }));
vi.mock('@mantle/voice', () => ({ getChatAdapter: () => h.adapter }));

vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    startTrace: async (_i: unknown, fn: () => Promise<unknown>) => fn(),
    currentTrace: () => ({ id: 'trace-1', costMicroUsd: 1234, tokens: { in: 10, out: 20 } }),
  };
});

const { runsWorkerTurnImpl } = await import('./runs-worker-turn');

const ITEM_ID = 'item-1';
const RUNNING_ITEM = {
  id: ITEM_ID,
  runId: 'run-1',
  kind: 'worker_invoke',
  state: 'running',
  attempt: 0,
  payload: { step: 'Summarise the invoices' },
  retryPolicy: { maxAttempts: 2 },
  agentId: 'worker-1',
};
const WORKER = {
  id: 'worker-1',
  slug: 'worker',
  model: 'x/y',
  provider: 'openrouter',
  apiKeyId: 'key-1',
  skillSlugs: [],
  toolGroupSlugs: [],
  params: {},
};

let fake: FakeDb;
let journal: Journal;

function seed(item: Record<string, unknown> | null = RUNNING_ITEM) {
  fake.queue('run_items', item ? [item] : []);
  fake.queue('runs', [{ id: 'run-1', ownerId: 'owner-1', agentId: 'responder-1' }]);
}

beforeEach(() => {
  fake = makeFakeDb();
  journal = makeJournal();
  h.db = fake.db as Record<string, unknown>;
  h.journal = journal;
  journal.beginPass();
  h.runsEnabled = true;
  h.worker = { ...WORKER };
  h.keyOk = true;
  h.adapter = { providerId: 'openrouter' };
  h.loopThrows = null;
  h.loopResult = {
    reply: '## Proposal\nUse supplier B.',
    toolCalls: [{ slug: 'search', error: null }],
  };
  h.completeResult = {
    completed: true,
    actions: [{ type: 'resume', runId: 'run-1', groupId: 'g1' }],
  };
  h.logs = [];
  h.completeItem = vi.fn(async () => h.completeResult);
  h.enqueueRunJobsSafe = vi.fn(async () => {});
  h.runPendingNotices = vi.fn(async () => {});
  h.requeueForRetry = vi.fn(async () => ({ type: 'dispatch', itemId: ITEM_ID }));
  h.spillToolResult = vi.fn(async () => ({ handle: 'tr_abc' }));
});

describe('runs worker turn — wake-up handling', () => {
  it('acks a stale wake-up without completing anything', async () => {
    seed({ ...RUNNING_ITEM, state: 'cancelled' });
    const res = await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(res).toEqual({ executed: false, outcome: 'stale' });
    expect(h.completeItem).not.toHaveBeenCalled();
  });

  it('acks when the item vanished', async () => {
    seed(null);
    const res = await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(res).toEqual({ executed: false, outcome: 'stale' });
    expect(h.completeItem).not.toHaveBeenCalled();
  });

  it('fails the item honestly when the flag is off in this runtime', async () => {
    h.runsEnabled = false;
    seed();
    const res = await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(res).toEqual({ executed: false, outcome: 'disabled' });
    expect(h.completeItem).toHaveBeenCalledTimes(1);
    expect(h.completeItem.mock.calls[0]![1]).toMatchObject({
      state: 'failed',
      failure: { type: 'disabled' },
    });
    // Counter-driving: the actions still reach the queue so the run advances.
    expect(h.enqueueRunJobsSafe).toHaveBeenCalledWith(h.completeResult.actions);
  });
});

describe('runs worker turn — execution', () => {
  it('completes done with the proposal, the mechanical ledger and accounting', async () => {
    seed();
    const res = await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(res).toEqual({ executed: true, outcome: 'done' });
    const opts = h.completeItem.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts).toMatchObject({
      itemId: ITEM_ID,
      state: 'done',
      costMicroUsd: 1234,
      traceRef: 'trace-1',
    });
    expect(opts.result).toMatchObject({
      proposal: '## Proposal\nUse supplier B.',
      worker: 'worker',
      output_handle: 'tr_abc',
      evidence: [{ tool: 'search', ok: true }],
    });
    expect(h.enqueueRunJobsSafe).toHaveBeenCalledWith(h.completeResult.actions);
  });

  it('re-stamps the deadline when execution actually starts', async () => {
    seed();
    await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(journal.recordedSteps()).toContain('restamp_deadline');
    expect(fake.writes.some((w) => w.table === 'run_items' && 'deadlineAt' in w.values)).toBe(true);
  });

  it('records failed tool calls in the ledger the auditor reads', async () => {
    h.loopResult = {
      reply: 'done',
      toolCalls: [
        { slug: 'search', error: null },
        { slug: 'fetch', error: 'HTTP 500 upstream' },
      ],
    };
    seed();
    await runsWorkerTurnImpl({ itemId: ITEM_ID });
    const opts = h.completeItem.mock.calls[0]![1] as { result: { evidence: unknown[] } };
    expect(opts.result.evidence).toEqual([
      { tool: 'search', ok: true },
      { tool: 'fetch', ok: false, error: 'HTTP 500 upstream' },
    ]);
  });

  it('inherits the responder route when the worker says inherit', async () => {
    h.worker = { ...WORKER, model: 'inherit', apiKeyId: null };
    fake.queue('run_items', [RUNNING_ITEM]);
    fake.queue('runs', [{ id: 'run-1', ownerId: 'owner-1', agentId: 'responder-1' }]);
    fake.queue('agents', [
      { id: 'responder-1', provider: 'anthropic', model: 'claude', slug: 'assistant' },
    ]);
    const res = await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(res).toEqual({ executed: true, outcome: 'done' });
  });

  it('fails worker_config when an inheriting worker has no resolvable responder', async () => {
    h.worker = { ...WORKER, model: 'inherit', apiKeyId: null };
    fake.queue('run_items', [RUNNING_ITEM]);
    fake.queue('runs', [{ id: 'run-1', ownerId: 'owner-1', agentId: null }]);
    const res = await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(res).toEqual({ executed: true, outcome: 'failed' });
    expect(h.completeItem.mock.calls[0]![1]).toMatchObject({
      state: 'failed',
      failure: { type: 'worker_config' },
    });
  });

  it('fails worker_config with no usable key', async () => {
    h.keyOk = false;
    seed();
    const res = await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(res.outcome).toBe('failed');
    expect(h.completeItem.mock.calls[0]![1]).toMatchObject({ failure: { type: 'worker_config' } });
  });
});

describe('runs worker turn — retry policy', () => {
  it('retries an empty proposal while attempts remain', async () => {
    h.loopResult = { reply: '   ', toolCalls: [] };
    seed();
    const res = await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(res).toEqual({ executed: true, outcome: 'retry' });
    expect(h.requeueForRetry).toHaveBeenCalledTimes(1);
    expect(h.completeItem).not.toHaveBeenCalled();
  });

  it('fails empty_output once attempts are exhausted', async () => {
    h.loopResult = { reply: '', toolCalls: [] };
    fake.queue('run_items', [{ ...RUNNING_ITEM, attempt: 1, retryPolicy: { maxAttempts: 2 } }]);
    fake.queue('runs', [{ id: 'run-1', ownerId: 'owner-1', agentId: 'responder-1' }]);
    const res = await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(res).toEqual({ executed: true, outcome: 'failed' });
    expect(h.requeueForRetry).not.toHaveBeenCalled();
    expect(h.completeItem.mock.calls[0]![1]).toMatchObject({ failure: { type: 'empty_output' } });
  });

  it('turns a model/transport error into a semantic retry', async () => {
    h.loopThrows = new Error('provider 529 overloaded');
    seed();
    const res = await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(res).toEqual({ executed: true, outcome: 'retry' });
    expect(h.requeueForRetry).toHaveBeenCalledTimes(1);
  });
});

describe('runs worker turn — crash replay (final-audit F4 regression)', () => {
  it('re-emits the RECORDED post-commit actions after a crash past completion', async () => {
    // ── Pass 1: a normal, complete execution. The item is now terminal in the
    // database and `complete_item` (with its actions) is in the journal.
    seed();
    const first = await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(first).toEqual({ executed: true, outcome: 'done' });
    expect(h.enqueueRunJobsSafe).toHaveBeenCalledTimes(1);

    // ── Pass 2: recovery re-runs the function. The world moved on — the item
    // reads 'done' now. Unjournaled glue would exit 'stale' here and the
    // recorded actions would never be enqueued (the F4 defect).
    const recovery = makeFakeDb();
    recovery.queue('run_items', [{ ...RUNNING_ITEM, state: 'done' }]);
    recovery.queue('runs', [{ id: 'run-1', ownerId: 'owner-1', agentId: 'responder-1' }]);
    h.db = recovery.db as Record<string, unknown>;
    journal.beginPass();

    const second = await runsWorkerTurnImpl({ itemId: ITEM_ID });

    expect(second).toEqual({ executed: true, outcome: 'done' });
    expect(journal.replayed).toContain('load_item');
    expect(journal.replayed).toContain('complete_item');
    // The engine's choreography is re-driven; duplicates no-op at the CAS.
    expect(h.enqueueRunJobsSafe).toHaveBeenCalledTimes(2);
    expect(h.enqueueRunJobsSafe.mock.calls[1]![0]).toEqual(h.completeResult.actions);
    // completeItem's BODY did not run twice — the journal served it.
    expect(h.completeItem).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-announce a question on replay, while still re-emitting jobs', async () => {
    // A `worker_invoke` completing can promote the next seq step — and if that
    // step is an `ask_human`, the engine hands back a `pending_created` notice
    // alongside the queue jobs. Jobs are idempotent at the engine CAS so a
    // replay may re-send them freely; a notice is a Telegram card / device
    // push with no CAS behind it, so replaying it would buzz the operator a
    // second time about a question they have already seen.
    h.completeResult = {
      completed: true,
      actions: [
        { type: 'resume', runId: 'run-1', groupId: 'g1' },
        {
          type: 'pending_created',
          ownerId: 'owner-1',
          pendingId: 'row-1',
          toolSlug: 'ask_human',
          args: { question: 'Ship it?' },
        },
      ],
    };
    seed();
    await runsWorkerTurnImpl({ itemId: ITEM_ID });
    expect(h.runPendingNotices).toHaveBeenCalledTimes(1);
    expect(h.enqueueRunJobsSafe).toHaveBeenCalledTimes(1);

    const recovery = makeFakeDb();
    recovery.queue('run_items', [{ ...RUNNING_ITEM, state: 'done' }]);
    recovery.queue('runs', [{ id: 'run-1', ownerId: 'owner-1', agentId: 'responder-1' }]);
    h.db = recovery.db as Record<string, unknown>;
    journal.beginPass();

    await runsWorkerTurnImpl({ itemId: ITEM_ID });

    // The step was replayed from the journal — its BODY never re-ran.
    expect(journal.replayed).toContain('notify_pending');
    expect(h.runPendingNotices).toHaveBeenCalledTimes(1);
    // ...but the queue jobs were re-emitted, exactly as the F4 contract wants.
    expect(h.enqueueRunJobsSafe).toHaveBeenCalledTimes(2);
  });
});
