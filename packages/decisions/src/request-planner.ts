/**
 * The request planner: the one place a decider use's list becomes requests.
 * Passage scoring, context pruning, version grouping, history recall, Journal
 * recall and rule reconcile all come here; the delegation hint and the fact
 * prefilter ask one question each, and `decide()` checks those against the
 * same limits.
 *
 * It reads the decider model's limits, splits the units to fit them
 * (`planGroups`), builds each request with the use's own builder, sends them
 * side by side and returns each group's outcome. With no limit that binds, a
 * use's requests are the ones it always sent (`groupSize` chunks). The
 * requests of one plan share a `DecideBatch`, so the breaker hears one
 * decision. Units too large for any request are refused, never sent; the
 * step says how many.
 */
import type { DecisionUse } from '@mantle/db';
import { step } from '@mantle/tracing';
import type { DecisionQuestion } from '@mantle/voice';
import {
  DecideBatch,
  decide,
  deciderRequestLimits,
  type DecideInput,
  type DecideOutcome,
} from './decide';
import { planGroups, type UnitSize } from './request-limits';

/** One request of a plan, as the use builds it. */
export type PlannedRequest = Pick<DecideInput, 'state' | 'questions' | 'summarize'>;

export type PlannedResult<T> = {
  /** Each request's units and outcome (null = no answer), in plan order. */
  results: Array<{ group: T[]; outcome: DecideOutcome | null }>;
  /** Requests planned (cache hits included). */
  calls: number;
  /** Requests that came back with no answer. */
  failed: number;
  /** Of `failed`: requests the open breaker kept from going out. */
  skipped: number;
  /** Units too large for any request: never sent, so unscored. */
  refused: number;
  /** Wall time of the whole plan. */
  ms: number;
};

export async function decidePlanned<T>(opts: {
  ownerId: string;
  use: DecisionUse;
  units: readonly T[];
  /** The use's own request size, in units: what it was measured at. */
  groupSize: number;
  /** JSON characters of the state every request carries (the message). */
  baseChars: number;
  sizeOf: (unit: T) => UnitSize;
  build: (group: T[]) => PlannedRequest;
  /** Share one `DecideBatch` even for a single request (the use counts the
   *  breaker's skips). Otherwise a single request reports to the breaker on
   *  its own, as `decide()` does. */
  alwaysBatch?: boolean;
  /** Give each request the worker timeout once per request of the plan
   *  (still capped), for requests that queue at the provider together. */
  scaleTimeout?: boolean;
}): Promise<PlannedResult<T>> {
  const t0 = Date.now();
  const sized = await deciderRequestLimits(opts.ownerId);
  const { groups, refused } = planGroups(opts.units, opts.sizeOf, {
    groupSize: opts.groupSize,
    baseChars: opts.baseChars,
    limits: sized?.limits ?? null,
  });
  if (refused.length > 0 && sized) await traceRefused(opts.use, sized, refused.length);

  const batch = groups.length > 1 || opts.alwaysBatch ? new DecideBatch() : undefined;
  const factor = opts.scaleTimeout && groups.length > 1 ? groups.length : undefined;
  const results = await Promise.all(
    groups.map(async (group) => {
      const req = opts.build(group);
      const outcome = await decide({
        ownerId: opts.ownerId,
        use: opts.use,
        ...req,
        ...(batch ? { batch } : {}),
        ...(factor ? { timeoutFactor: factor } : {}),
      });
      return { group, outcome };
    }),
  );
  batch?.settle();
  const failed = results.filter((r) => !r.outcome).length;
  return {
    results,
    calls: results.length,
    failed,
    skipped: batch?.skipped ?? 0,
    refused: refused.length,
    ms: Date.now() - t0,
  };
}

/** One step per plan that refused units, so a model too small for a use
 *  shows in /traces instead of failing silently. */
async function traceRefused(
  use: DecisionUse,
  sized: { model: string; limits: { maxQuestions: number | null; maxInputTokens: number | null } },
  refused: number,
): Promise<void> {
  await step(
    {
      name: `decide_${use}`,
      kind: 'llm_call',
      input: { use, model: sized.model, refused },
    },
    async (h) => {
      h.setMeta({
        use,
        model: sized.model,
        over_limit: `${refused} item(s) too large for one request`,
        max_questions: sized.limits.maxQuestions,
        max_input_tokens: sized.limits.maxInputTokens,
      });
      h.setSkipped('over_limit');
    },
  );
}

/** The JSON size of one unit: its state entry and its questions. */
export function unitSize(entry: unknown, questions: Record<string, DecisionQuestion>): UnitSize {
  return {
    chars: JSON.stringify(entry).length + JSON.stringify(questions).length,
    questions: Object.keys(questions).length,
  };
}
