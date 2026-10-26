/**
 * A delegated child's tokens count on the turn that started it, for the
 * turn's own budget (onClose's `delegated`; workspace delegation, owner
 * decision 2026-10-26: a member's turn settles its ledger slot with them),
 * and never on the turn's row (no double count in the aggregates: the
 * child's trace owns its spend).
 *
 * Mock strategy mirrors abort-usage.test.ts: `@mantle/db` is stubbed with a
 * chain-capturing `db`, and the trace-close UPDATE payloads are read.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tracesTable: { __t: 'traces' },
  traceStepsTable: { __t: 'traceSteps' },
  traceUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mantle/db', () => ({
  get systemDb(): unknown {
    return (this as { db: unknown }).db;
  },
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

import { startTrace } from './store';
import { recordUsage } from './spend';

const usage = (inputTokens: number, outputTokens: number) =>
  recordUsage({
    capability: 'chat',
    provider: 'p',
    model: 'm',
    inputTokens,
    outputTokens,
    reportedCostUsd: 0,
  });

afterEach(() => {
  h.traceUpdates.length = 0;
});

describe('a delegated child’s tokens reach the turn’s onClose, not its row', () => {
  it('own and delegated tokens are handed apart; a grandchild counts on the turn too', async () => {
    const closes: Array<{ own: unknown; delegated: unknown }> = [];
    await startTrace(
      {
        ownerId: 'o1',
        kind: 'responder_turn',
        onClose: (own, delegated) => closes.push({ own, delegated }),
      },
      async () => {
        usage(100, 10);
        await startTrace(
          { ownerId: 'o1', kind: 'manual', subjectKind: 'child_agent' },
          async () => {
            usage(50, 5);
            await startTrace({ ownerId: 'o1', kind: 'manual' }, async () => {
              usage(7, 3);
            });
          },
        );
        // A child that fails still spent.
        await startTrace({ ownerId: 'o1', kind: 'manual' }, async () => {
          usage(1, 1);
          throw new Error('child failed');
        }).catch(() => undefined);
      },
    );
    expect(closes).toEqual([{ own: { in: 100, out: 10 }, delegated: { in: 58, out: 9 } }]);
    // The turn's row keeps its own tokens only.
    const root = h.traceUpdates.at(-1)!;
    expect(root.tokensIn).toBe(100);
    expect(root.tokensOut).toBe(10);
  });
});
