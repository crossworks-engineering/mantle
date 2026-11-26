/**
 * The spend backfill's choice per stored step, and its report
 * (lib/maintenance/spend-backfill.ts). Pure: which step gets a list price,
 * which stays at $0 and why, for each shape a stored step meta comes in.
 * The price is the live recorder's own (`priceUsage`), so these numbers are
 * the price table's.
 */
import { describe, expect, it } from 'vitest';
import { priceUsage } from '@mantle/tracing';
import {
  BASIS,
  CALIBRATION,
  chooseForStep,
  MARK,
  newTally,
  reportLines,
  tallyStep,
  totalMicroUsd,
  type StepRow,
} from './spend-backfill';

const step = (meta: Record<string, unknown>, inputProvider: string | null = null) => ({
  meta,
  inputProvider,
});

/** A read worker's step as the recorder wrote it before the fix: tokens,
 *  the route, and a cost of 0. */
const vision = {
  model: 'google/gemini-3.8-flash',
  provider: 'openrouter',
  tokens_in: 1_000_000,
  tokens_out: 100_000,
  cost_micro_usd: 0,
};

describe('the mark', () => {
  it('is one fixed key and one fixed basis (the SQL of the task writes the same text)', () => {
    // spend-backfill.ts writes these two as SQL literals (MARK_SQL, BASIS_SQL);
    // spend-backfill.db.test.ts reads the stored mark back.
    expect(MARK).toBe('cost_backfill');
    expect(BASIS).toBe('list_price');
  });
});

describe('chooseForStep: the recorder shape', () => {
  it('prices a $0 step at the list price of its tokens', () => {
    // $0.825 per 1M in, $4.125 per 1M out.
    expect(chooseForStep(step(vision))).toEqual({
      act: 'price',
      microUsd: 825_000 + 412_500,
      provider: 'openrouter',
      model: 'google/gemini-3.8-flash',
      tokensIn: 1_000_000,
      tokensOut: 100_000,
    });
  });

  it('prices with the same code as the live path', () => {
    const c = chooseForStep(step({ ...vision, cache_read: 400_000 }));
    const live = priceUsage({
      capability: 'vision',
      provider: 'openrouter',
      model: 'google/gemini-3.8-flash',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 400_000,
    });
    expect(c).toMatchObject({ act: 'price', microUsd: live.costMicroUsd });
  });

  it('prices the bare embedding id and the direct Anthropic id', () => {
    expect(
      chooseForStep(
        step({
          model: 'text-embedding-3-large',
          provider: 'openrouter',
          tokens_in: 1_000_000,
          tokens_out: 0,
          cost_micro_usd: 0,
        }),
      ),
    ).toMatchObject({ act: 'price', microUsd: 130_000 });
    expect(
      chooseForStep(
        step({
          model: 'claude-sonnet-5-5',
          provider: 'anthropic',
          tokens_in: 1_000_000,
          tokens_out: 0,
          cache_read: 0,
          cost_micro_usd: 0,
        }),
      ),
    ).toMatchObject({ act: 'price', microUsd: 2_000_000 });
  });

  it('prices a step billed by the unit', () => {
    expect(
      chooseForStep(
        step({
          model: 'x-ai/grok-voice-tts-1.0',
          provider: 'openrouter',
          characters: 2000,
          cost_micro_usd: 0,
        }),
      ),
    ).toMatchObject({ act: 'price', microUsd: 30_000 });
  });

  it('never touches a cost above 0, or a marked step', () => {
    expect(chooseForStep(step({ ...vision, cost_micro_usd: 12 }))).toMatchObject({
      act: 'leave',
      why: 'has_cost',
    });
    expect(
      chooseForStep(step({ ...vision, [MARK]: { micro_usd: 5, basis: 'list_price' } })),
    ).toMatchObject({ act: 'leave', why: 'has_cost' });
  });

  it('leaves a free route at $0: the local provider, a :free id', () => {
    expect(
      chooseForStep(
        step({
          model: 'embeddinggemma:latest',
          provider: 'local',
          tokens_in: 500,
          tokens_out: 0,
          cost_micro_usd: 0,
        }),
      ),
    ).toMatchObject({ act: 'leave', why: 'free' });
    // A local model is free whatever its name.
    expect(chooseForStep(step({ ...vision, provider: 'local' }))).toMatchObject({ why: 'free' });
    expect(chooseForStep(step({ ...vision, model: 'made-up/model:free' }))).toMatchObject({
      why: 'free',
    });
  });

  it('leaves a timed-out step as it is', () => {
    expect(chooseForStep(step({ ...vision, timed_out: 1 }))).toMatchObject({
      act: 'leave',
      why: 'timed_out',
    });
  });

  it('leaves a model with no price row, and says so', () => {
    expect(chooseForStep(step({ ...vision, model: 'made-up/unlisted' }))).toEqual({
      act: 'leave',
      why: 'unpriced',
      provider: 'openrouter',
      model: 'made-up/unlisted',
      tokensIn: 1_000_000,
      tokensOut: 100_000,
    });
  });

  it('leaves a step with no usage, with no model, or whose tokens round to $0', () => {
    expect(chooseForStep(step({ ...vision, tokens_in: 0, tokens_out: 0 }))).toMatchObject({
      why: 'no_usage',
    });
    expect(chooseForStep(step({ ...vision, model: '' }))).toMatchObject({ why: 'no_model' });
    expect(
      chooseForStep(
        step({
          model: 'openai/text-embedding-3-large',
          provider: 'openrouter',
          tokens_in: 2,
          tokens_out: 0,
          cost_micro_usd: 0,
        }),
      ),
    ).toMatchObject({ why: 'rounds_to_zero' });
  });

  it('reads no number it cannot trust: text, a negative, a fraction of a token', () => {
    expect(chooseForStep(step({ ...vision, tokens_in: 'many', tokens_out: -5 }))).toMatchObject({
      why: 'no_usage',
    });
    // A digit string is a count (a jsonb number read as text).
    expect(chooseForStep(step({ ...vision, tokens_in: '1000000', tokens_out: 0 }))).toMatchObject({
      act: 'price',
      microUsd: 825_000,
    });
  });
});

describe('chooseForStep: the older shapes', () => {
  it('a meta from before `provider`: the route in the step input, same price', () => {
    const { provider: _p, ...old } = vision;
    expect(chooseForStep(step(old, 'openrouter'))).toMatchObject({
      act: 'price',
      provider: 'openrouter',
      microUsd: 825_000 + 412_500,
    });
    // No route anywhere: still priced by its model, the provider left empty.
    expect(chooseForStep(step(old))).toMatchObject({ act: 'price', provider: '' });
    // A local route named only in the input is still free.
    expect(chooseForStep(step(old, 'local'))).toMatchObject({ why: 'free' });
  });

  it('camelCase tokens with a recorded cost of 0 are read as counts', () => {
    expect(
      chooseForStep(
        step({
          model: 'google/gemini-3.8-flash',
          adapter: 'openrouter-vision',
          tokensIn: 1_000_000,
          tokensOut: 0,
          cost_micro_usd: 0,
        }),
      ),
    ).toMatchObject({ act: 'price', provider: 'openrouter', microUsd: 825_000 });
  });

  it('tokens with NO recorded cost are never priced: the cost went to the trace another way', () => {
    expect(
      chooseForStep(
        step({
          ran: true,
          model: 'gpt-4o-mini',
          adapter: 'openai-vision',
          tokensIn: 25_000,
          tokensOut: 48,
        }),
      ),
    ).toEqual({
      act: 'leave',
      why: 'old_shape',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tokensIn: 25_000,
      tokensOut: 48,
    });
  });

  it('never takes a model from anywhere but the step meta', () => {
    // The step input can name a model; the meta has none: not priced.
    expect(
      chooseForStep(step({ tokens_in: 1000, tokens_out: 10, cost_micro_usd: 0 }, 'openrouter')),
    ).toMatchObject({ act: 'leave', why: 'no_model', model: '' });
  });
});

describe('chooseForStep: a run that has not ended', () => {
  it('leaves a step it could price, and keeps the amount for the report', () => {
    expect(chooseForStep(step(vision), { runOpen: true })).toEqual({
      act: 'leave',
      why: 'run_open',
      microUsd: 825_000 + 412_500,
      provider: 'openrouter',
      model: 'google/gemini-3.8-flash',
      tokensIn: 1_000_000,
      tokensOut: 100_000,
    });
    // The same step once its run has ended: priced.
    expect(chooseForStep(step(vision), { runOpen: false })).toMatchObject({ act: 'price' });
  });

  it('a step it would not price keeps its own reason', () => {
    expect(chooseForStep(step({ ...vision, provider: 'local' }), { runOpen: true })).toMatchObject({
      why: 'free',
    });
    expect(
      chooseForStep(step({ ...vision, model: 'made-up/unlisted' }), { runOpen: true }),
    ).toMatchObject({ why: 'unpriced' });
    expect(chooseForStep(step({ ...vision, cost_micro_usd: 7 }), { runOpen: true })).toMatchObject({
      why: 'has_cost',
    });
  });
});

describe('the calibration line', () => {
  it('says how far a list price was from a bill, and in which direction', () => {
    expect(CALIBRATION).toContain('about 8 percent above');
    expect(CALIBRATION).toContain('2026-11-26');
  });
});

describe('the report', () => {
  const row = (
    id: string,
    traceId: string,
    meta: Record<string, unknown>,
    at: string,
  ): StepRow => ({
    id,
    traceId,
    meta,
    inputProvider: null,
    startedAt: at,
  });

  it('sums per provider and model, and prints numbers and ids only', () => {
    const t = newTally();
    const rows = [
      row('s1', 't1', vision, '2026-11-06T10:00:00Z'),
      row('s2', 't1', vision, '2026-11-20T10:00:00Z'),
      row('s3', 't2', { ...vision, model: 'made-up/unlisted' }, '2026-11-07T10:00:00Z'),
      row('s4', 't3', { ...vision, provider: 'local' }, '2026-11-08T10:00:00Z'),
      row('s5', 't4', { ...vision, timed_out: 1 }, '2026-11-09T10:00:00Z'),
      row('s6', 't5', { model: 'gpt-4o-mini', tokensIn: 10, tokensOut: 1 }, '2026-09-01T10:00:00Z'),
    ];
    for (const r of rows) tallyStep(t, r, chooseForStep(r));
    // Two steps of a run that has not ended: on their own line, out of the total.
    for (const id of ['s7', 's8']) {
      const r = row(id, 't6', vision, '2026-11-25T10:00:00Z');
      tallyStep(t, r, chooseForStep(r, { runOpen: true }));
    }
    expect(t.read).toBe(8);
    expect(totalMicroUsd(t)).toBe(2 * (825_000 + 412_500));
    expect(t.traces.size).toBe(1);
    expect(t.left).toEqual({ free: 1, timed_out: 1 });
    expect(t.runOpen).toEqual({ steps: 2, microUsd: 2 * (825_000 + 412_500) });
    const lines = reportLines(t, 'to price');
    expect(lines).toEqual([
      'steps read: 8',
      'date range of the steps to price: 2026-11-06 to 2026-11-20',
      'to price, per provider and model (list price, not the billed cost):',
      '  openrouter  google/gemini-3.8-flash  steps 2  tokens in 2000000  out 200000  $2.4750',
      'not priced, left at $0, per reason, provider and model:',
      '  no price row  openrouter  made-up/unlisted  steps 1  tokens in 1000000  out 100000',
      '  old shape, no recorded cost  (no provider)  gpt-4o-mini  steps 1  tokens in 10  out 1',
      'left as they are: free route 1; timed out 1',
      'left: run still open  steps 2  $2.4750  (a later run prices them, after the run has ended)',
      'total to price: 2 steps in 1 traces, $2.4750',
    ]);
  });

  it('an empty walk says none', () => {
    expect(reportLines(newTally(), 'to price')).toEqual([
      'steps read: 0',
      'date range of the steps to price: none to none',
      'to price, per provider and model (list price, not the billed cost):',
      '  none',
      'total to price: 0 steps in 0 traces, $0.0000',
    ]);
  });
});
