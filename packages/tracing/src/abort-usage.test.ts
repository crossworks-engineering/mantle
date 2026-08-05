/**
 * A user Stop must not lose the money: LLM usage recorded BEFORE (and even
 * after) the turn's abort fires still lands on the responder_turn trace's
 * totals when it closes. This is the accounting half of the premature-Enter
 * correction flow — the cancelled turn's partial spend stays visible in
 * /debug's ledger rather than silently vanishing with the abandoned reply.
 *
 * Mock strategy mirrors store.test.ts: `@mantle/db` is stubbed with a
 * chain-capturing `db`, and we assert on the trace-close UPDATE payload.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tracesTable: { __t: 'traces' },
  traceStepsTable: { __t: 'traceSteps' },
  traceUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mantle/db', () => ({
  traces: h.tracesTable,
  traceSteps: h.traceStepsTable,
  db: {
    insert: () => ({ values: async () => {} }),
    update: (tbl: unknown) => ({
      set: (payload: Record<string, unknown>) => {
        if (tbl === h.tracesTable) h.traceUpdates.push(payload);
        return { where: () => ({ catch: () => {} }) };
      },
    }),
  },
}));

import {
  abortTurn,
  recordStepUsage,
  registerTurnAbort,
  startTrace,
  unregisterTurnAbort,
} from './store';

afterEach(() => {
  h.traceUpdates.length = 0;
});

describe('aborted turn keeps its partial spend', () => {
  it('usage recorded around an abortTurn still lands on the closed trace', async () => {
    const turnId = 'turn-abort-1';
    const controller = registerTurnAbort(turnId, 'owner-1');
    try {
      await startTrace({ ownerId: 'owner-1', kind: 'responder_turn', turnId }, async () => {
        // First LLM round bills before the user hits Stop…
        recordStepUsage({ model: 'm', input: 100, output: 40, costMicroUsd: 700 });
        expect(abortTurn('owner-1', turnId)).toBe(true);
        expect(controller.signal.aborted).toBe(true);
        // …and the streaming adapter's final partial-usage report lands after.
        recordStepUsage({ model: 'm', input: 0, output: 15, costMicroUsd: 100 });
      });
    } finally {
      unregisterTurnAbort(turnId);
    }

    const close = h.traceUpdates.find((u) => u.status === 'success');
    expect(close, 'the trace should close with totals').toBeTruthy();
    expect(close!.tokensIn).toBe(100);
    expect(close!.tokensOut).toBe(55);
    expect(close!.costMicroUsd).toBe(800);
  });

  it('abortTurn stays owner-isolated (a foreign owner cannot abort the turn)', () => {
    const turnId = 'turn-abort-2';
    registerTurnAbort(turnId, 'owner-1');
    try {
      expect(abortTurn('someone-else', turnId)).toBe(false);
      expect(abortTurn('owner-1', turnId)).toBe(true);
    } finally {
      unregisterTurnAbort(turnId);
    }
  });
});
