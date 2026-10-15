/**
 * The one spend recorder (A10 #5): its usage shape, its pricing, and where it
 * lands (trace totals, step meta summed per step, prelude, a charged trace,
 * a trace that already closed). The per-call-path record lives in
 * packages/runtime/src/agent/spend-recording.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tracesTable: { __t: 'traces' },
  traceStepsTable: { __t: 'traceSteps' },
  traceUpdates: [] as Array<Record<string, unknown>>,
  stepUpdates: [] as Array<Record<string, unknown>>,
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
        if (tbl === h.traceStepsTable) h.stepUpdates.push(payload);
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));

import {
  chargeTo,
  createTracePrelude,
  spendTarget,
  startTrace,
  step,
  withTracePrelude,
  type SpendTarget,
} from './store';
import { captureLlmUsage, recordUsage, usageCostMicroUsd, type ProviderUsage } from './spend';

afterEach(() => {
  h.traceUpdates.length = 0;
  h.stepUpdates.length = 0;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const chat = (over: Partial<ProviderUsage> = {}): ProviderUsage => ({
  capability: 'chat',
  provider: 'anthropic',
  model: 'anthropic/claude-sonnet-4.6',
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 300,
  ...over,
});

describe('usageCostMicroUsd', () => {
  it('prefers the reported cost', () => {
    expect(usageCostMicroUsd(chat({ reportedCostUsd: 0.0123 }))).toBe(12_300);
  });

  it('else prices on the table, cache reads at their rate', () => {
    // (1000 - 300) * 3e-6 + 300 * 3e-7 + 200 * 1.5e-5 = 0.00519
    expect(usageCostMicroUsd(chat())).toBe(5190);
  });

  it('tries priceAs in order: the requested id, then the served one', () => {
    const served = 'anthropic/claude-sonnet-4.6';
    expect(usageCostMicroUsd(chat({ model: 'dated-x', priceAs: ['dated-x', served] }))).toBe(5190);
    expect(usageCostMicroUsd(chat({ model: 'x', priceAs: ['nope', null, 'nope-2'] }))).toBe(0);
  });

  it('a unit-billed call with no reported cost is $0 (no price table for units)', () => {
    expect(
      usageCostMicroUsd({
        capability: 'tts',
        provider: 'openai',
        model: 'tts-1',
        units: { kind: 'characters', count: 400 },
      }),
    ).toBe(0);
  });
});

describe('recordUsage', () => {
  it('adds to the trace totals (cache writes into input) and the step meta', async () => {
    await startTrace({ ownerId: 'o', kind: 'manual' }, () =>
      step({ name: 's', kind: 'llm_call' }, async () => {
        recordUsage(chat({ cacheWriteTokens: 100 }));
      }),
    );
    await flush();
    expect(h.traceUpdates.at(-1)).toMatchObject({
      tokensIn: 1100,
      tokensOut: 200,
      tokensCacheRead: 300,
      costMicroUsd: 5190,
    });
    expect(h.stepUpdates.at(-1)!.meta).toEqual({
      model: 'anthropic/claude-sonnet-4.6',
      provider: 'anthropic',
      tokens_in: 1000,
      tokens_out: 200,
      cache_read: 300,
      cache_write: 100,
      cost_micro_usd: 5190,
    });
  });

  it('sums a step with several calls; the last model names it', async () => {
    await startTrace({ ownerId: 'o', kind: 'manual' }, () =>
      step({ name: 's', kind: 'embed' }, async () => {
        for (const n of [10, 20]) {
          recordUsage({
            capability: 'embedding',
            provider: 'local',
            model: 'm',
            inputTokens: n,
            outputTokens: 0,
          });
        }
      }),
    );
    await flush();
    expect(h.stepUpdates.at(-1)!.meta).toEqual({
      model: 'm',
      provider: 'local',
      tokens_in: 30,
      tokens_out: 0,
      cost_micro_usd: 0,
    });
  });

  it('a unit call carries its unit key and no token keys', async () => {
    await startTrace({ ownerId: 'o', kind: 'manual' }, () =>
      step({ name: 's', kind: 'compute' }, async () => {
        recordUsage({
          capability: 'stt',
          provider: 'openai',
          model: 'whisper-1',
          units: { kind: 'audio_seconds', count: 42 },
        });
      }),
    );
    await flush();
    expect(h.stepUpdates.at(-1)!.meta).toEqual({
      model: 'whisper-1',
      provider: 'openai',
      audio_seconds: 42,
      cost_micro_usd: 0,
    });
  });

  it('goes to the prelude step before the trace opens', async () => {
    const prelude = createTracePrelude();
    await withTracePrelude(prelude, () =>
      step({ name: 'p', kind: 'llm_call' }, async () => {
        recordUsage(chat({ reportedCostUsd: 0.001 }));
      }),
    );
    expect(prelude.steps[0]).toMatchObject({
      tokens: { in: 1000, out: 200, cacheRead: 300 },
      costMicroUsd: 1000,
      meta: { model: 'anthropic/claude-sonnet-4.6', cost_micro_usd: 1000 },
    });
  });

  it('outside any trace or prelude it is a no-op that still returns the cost', () => {
    expect(recordUsage(chat({ reportedCostUsd: 0.002 }))).toBe(2000);
  });

  it("a child trace's call never lands on the parent's step", async () => {
    await startTrace({ ownerId: 'o', kind: 'responder_turn' }, () =>
      step({ name: 'tool: invoke_agent', kind: 'compute' }, () =>
        startTrace({ ownerId: 'o', kind: 'responder_turn' }, async () => {
          recordUsage(chat());
        }),
      ),
    );
    await flush();
    const [child, parent] = h.traceUpdates;
    expect(child).toMatchObject({ costMicroUsd: 5190 });
    expect(parent).toMatchObject({ costMicroUsd: 0 });
    expect(h.stepUpdates.at(-1)!.meta).toEqual({});
  });
});

describe('chargeTo', () => {
  it('counts toward the trace totals only, never the running step', async () => {
    await startTrace({ ownerId: 'o', kind: 'responder_turn' }, () =>
      step({ name: 'tool: x', kind: 'compute' }, () =>
        chargeTo(spendTarget(), async () => {
          recordUsage(chat());
        }),
      ),
    );
    await flush();
    expect(h.traceUpdates.at(-1)).toMatchObject({ costMicroUsd: 5190 });
    expect(h.stepUpdates.at(-1)!.meta).toEqual({});
  });

  it('after the trace closed: an increment, written after the close', async () => {
    let target: SpendTarget | null = null;
    await startTrace({ ownerId: 'o', kind: 'responder_turn' }, async () => {
      target = spendTarget();
    });
    await chargeTo(target, async () => {
      recordUsage(chat());
    });
    await flush();
    expect(h.traceUpdates).toHaveLength(2);
    expect(h.traceUpdates[0]).toMatchObject({ status: 'success', costMicroUsd: 0 });
    // The increment is an SQL expression (column + n), not an absolute value.
    expect(Object.keys(h.traceUpdates[1]!).sort()).toEqual([
      'costMicroUsd',
      'tokensCacheRead',
      'tokensIn',
      'tokensOut',
    ]);
  });

  it('a call still running when the trace closes lands by increment too', async () => {
    let late: Promise<unknown> = Promise.resolve();
    await startTrace({ ownerId: 'o', kind: 'responder_turn' }, async () => {
      late = (async () => {
        await new Promise((r) => setTimeout(r, 5));
        recordUsage(chat());
      })();
    });
    await late;
    await flush();
    expect(h.traceUpdates).toHaveLength(2);
    expect(h.traceUpdates[0]).toMatchObject({ costMicroUsd: 0 });
  });

  it('a null target runs the work as is', async () => {
    expect(await chargeTo(null, async () => 7)).toBe(7);
  });
});

describe('captureLlmUsage (the raw-response reader)', () => {
  const inStep = async (fn: () => void) => {
    await startTrace({ ownerId: 'o', kind: 'manual' }, () =>
      step({ name: 's', kind: 'compute' }, async () => fn()),
    );
    await flush();
    return { trace: h.traceUpdates.at(-1)!, meta: h.stepUpdates.at(-1)!.meta };
  };

  it('reads camelCase usage and the reported cost', async () => {
    const got = await inStep(() =>
      captureLlmUsage(
        { usage: { promptTokens: 100, completionTokens: 50, cost: 0.0123 } },
        'perplexity/sonar-pro',
      ),
    );
    expect(got.trace).toMatchObject({ tokensIn: 100, tokensOut: 50, costMicroUsd: 12_300 });
    expect(got.meta).toMatchObject({ provider: 'openrouter', model: 'perplexity/sonar-pro' });
  });

  it('reads snake_case usage with a cache read', async () => {
    const got = await inStep(() =>
      captureLlmUsage(
        { usage: { prompt_tokens: 7, completion_tokens: 3, cache_read_input_tokens: 2 } },
        'anthropic/claude-sonnet-4.6',
      ),
    );
    expect(got.trace).toMatchObject({ tokensIn: 7, tokensOut: 3, tokensCacheRead: 2 });
  });

  it('counts the cache-write tokens (A10 #5: skipped before)', async () => {
    const got = await inStep(() =>
      captureLlmUsage(
        {
          usage: {
            prompt_tokens: 400,
            completion_tokens: 300,
            cost: 0.006,
            prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 50 },
          },
        },
        'perplexity/sonar',
      ),
    );
    expect(got.trace).toMatchObject({ tokensIn: 450, tokensCacheRead: 20, costMicroUsd: 6000 });
    expect(got.meta).toMatchObject({ tokens_in: 400, cache_read: 20, cache_write: 50 });
  });

  it('falls back to the price table when no cost is reported', () => {
    // sonar-pro: 1000 * 3e-6 + 500 * 15e-6 = 0.0105 USD
    expect(
      captureLlmUsage(
        { usage: { prompt_tokens: 1000, completion_tokens: 500 } },
        'perplexity/sonar-pro',
      ),
    ).toBe(10_500);
  });

  it('ignores a response without usage', () => {
    expect(captureLlmUsage({ choices: [] }, 'm')).toBe(0);
    expect(captureLlmUsage(null, 'm')).toBe(0);
  });
});
