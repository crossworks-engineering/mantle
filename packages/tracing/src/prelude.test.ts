/**
 * Prelude: steps that run BEFORE their trace opens (a responder turn loads its
 * context, and makes the decider's pruning + hint calls, before the trace
 * exists). They must land in the trace that opens next, first, with their
 * tokens + cost counted, and only once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tracesTable: { __t: 'traces' },
  traceStepsTable: { __t: 'traceSteps' },
  stepInserts: [] as Array<Record<string, unknown>>,
  traceUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mantle/db', () => ({
  // Infrastructure writes go through systemDb; the fake stands in for both.
  get systemDb(): unknown {
    return (this as { db: unknown }).db;
  },
  traces: h.tracesTable,
  traceSteps: h.traceStepsTable,
  db: {
    insert: (tbl: unknown) => ({
      values: async (v: Record<string, unknown> | Array<Record<string, unknown>>) => {
        if (tbl === h.traceStepsTable) h.stepInserts.push(...(Array.isArray(v) ? v : [v]));
      },
    }),
    update: (tbl: unknown) => ({
      set: (payload: Record<string, unknown>) => {
        if (tbl === h.tracesTable) h.traceUpdates.push(payload);
        return { where: () => ({ catch: () => {} }) };
      },
    }),
  },
}));

import { createTracePrelude, startTrace, step, withTracePrelude } from './store';

afterEach(() => {
  h.stepInserts.length = 0;
  h.traceUpdates.length = 0;
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('trace prelude', () => {
  it('holds pre-trace steps and writes them first, with their usage', async () => {
    const prelude = createTracePrelude();
    const got = await withTracePrelude(prelude, () =>
      step({ name: 'decide_context_pruning', kind: 'llm_call', input: { use: 'x' } }, async (s) => {
        s.addTokens({ input: 100, output: 2 });
        s.addCost(40);
        s.setMeta({ use: 'context_pruning' });
        await step({ name: 'embed', kind: 'embed' }, async () => 1);
        return 'answer';
      }),
    );
    expect(got).toBe('answer');
    expect(h.stepInserts).toHaveLength(0); // nothing written before the trace
    expect(prelude.steps).toHaveLength(2);

    await startTrace({ kind: 'responder_turn', ownerId: 'o', prelude }, async () => {
      await step({ name: 'llm', kind: 'llm_call' }, async (s) => s.addCost(1000));
    });
    await flush();

    const [pruning, embed, llm] = h.stepInserts;
    expect(pruning).toMatchObject({
      name: 'decide_context_pruning',
      status: 'success',
      ordinal: 0,
      parentStepId: null,
      meta: { use: 'context_pruning', prelude: true },
    });
    expect(embed).toMatchObject({ name: 'embed', ordinal: 0, parentStepId: pruning!.id });
    expect(llm).toMatchObject({ name: 'llm', ordinal: 1 });
    expect(h.traceUpdates.at(-1)).toMatchObject({
      tokensIn: 100,
      tokensOut: 2,
      costMicroUsd: 1040,
      stepCount: 3,
    });
  });

  it('records a skipped (failed) decision as skipped', async () => {
    const prelude = createTracePrelude();
    await withTracePrelude(prelude, () =>
      step({ name: 'decide_delegation_hint', kind: 'llm_call' }, async (s) => {
        s.setSkipped('decision_failed');
        return null;
      }),
    );
    expect(prelude.steps[0]).toMatchObject({
      status: 'skipped',
      meta: { skipped: 'decision_failed' },
    });
  });

  it('is consumed by the first trace (a retry trace does not double-count)', async () => {
    const prelude = createTracePrelude();
    await withTracePrelude(prelude, () => step({ name: 'a', kind: 'compute' }, async () => 1));
    await startTrace({ kind: 'responder_turn', ownerId: 'o', prelude }, async () => {});
    await startTrace({ kind: 'responder_turn', ownerId: 'o', prelude }, async () => {});
    await flush();
    expect(h.stepInserts.filter((r) => r.name === 'a')).toHaveLength(1);
  });

  it('inside an open trace, steps go to that trace as usual', async () => {
    const prelude = createTracePrelude();
    await startTrace({ kind: 'responder_turn', ownerId: 'o' }, () =>
      withTracePrelude(prelude, () => step({ name: 'b', kind: 'compute' }, async () => 1)),
    );
    expect(prelude.steps).toHaveLength(0);
    expect(h.stepInserts.map((r) => r.name)).toContain('b');
  });

  it('without a prelude, a pre-trace step still runs untraced', async () => {
    expect(await step({ name: 'c', kind: 'compute' }, async () => 7)).toBe(7);
    expect(h.stepInserts).toHaveLength(0);
  });
});
