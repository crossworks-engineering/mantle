/**
 * The size of a decision request, in one place. A request is sized from the
 * chosen model's limits (its profile in @mantle/client-types, plus the live
 * catalog's context size), not from a fixed window. `planGroups` splits a
 * use's items into requests that fit; `requestOverLimit` is the last check
 * in `decide()`, so nothing above a limit is ever sent.
 *
 * A model with no known limit (a tested model, catalog not loaded) keeps each
 * use's own group size, so its requests are the ones the uses were measured
 * with. Pure, except `limitsForModel`, which reads the cached catalog.
 */
import {
  decisionRequestLimits,
  type DecisionRequestLimits,
} from '@mantle/client-types/decision-models';
import type { DecisionQuestion } from '@mantle/voice';
import { contextLimitFor } from '@mantle/tracing';

export type { DecisionRequestLimits };

/** Characters per token for the estimate. The probe's full-size request was
 *  about 75,000 characters and 19,000 tokens (about 4 a token); 3 counts
 *  high, so a model with a less efficient tokenizer still fits. */
export const CHARS_PER_TOKEN = 3;

/** The planner fills a request to this share of the model's token limit.
 *  The rest is room for what the estimate does not see; `decide()` refuses
 *  only above the full limit. */
export const PLAN_HEADROOM = 0.9;

/** The limits of a decision model id, read from its profile and the cached
 *  catalog (no fetch). */
export function limitsForModel(model: string): DecisionRequestLimits {
  return decisionRequestLimits(model, contextLimitFor(model));
}

/** Estimated input tokens of a request: its JSON, at `CHARS_PER_TOKEN`. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The JSON length of a request's state and questions. */
export function requestChars(state: unknown, questions: Record<string, DecisionQuestion>): number {
  return JSON.stringify({ state, questions }).length;
}

/** Why a request may not be sent to a model with these limits, or null. */
export function requestOverLimit(
  limits: DecisionRequestLimits,
  state: unknown,
  questions: Record<string, DecisionQuestion>,
): { questions: number; estimatedTokens: number | null; reason: string } | null {
  const count = Object.keys(questions).length;
  if (limits.maxQuestions !== null && count > limits.maxQuestions) {
    return {
      questions: count,
      estimatedTokens: null,
      reason: `${count} questions, the model takes at most ${limits.maxQuestions}`,
    };
  }
  if (limits.maxInputTokens === null) return null;
  const tokens = estimateTokens(requestChars(state, questions));
  if (tokens <= limits.maxInputTokens) return null;
  return {
    questions: count,
    estimatedTokens: tokens,
    reason: `about ${tokens} input tokens, the model takes at most ${limits.maxInputTokens}`,
  };
}

/** What one item adds to a request: its JSON characters (state entry and
 *  questions) and its number of questions. */
export type UnitSize = { chars: number; questions: number };

/**
 * Pure: split `units` into requests. With no limit that binds, the units go
 * in chunks of `groupSize`, in order, as each use always sent them. When the
 * model's limits need more requests than that, the units are spread evenly
 * over as many as the limits need, and no request goes above a limit
 * (`baseChars` is the part of the state every request carries). A unit too
 * large for any request on its own is refused, not sent: the caller treats it
 * as unscored.
 */
export function planGroups<T>(
  units: readonly T[],
  sizeOf: (unit: T) => UnitSize,
  opts: { groupSize: number; baseChars: number; limits: DecisionRequestLimits | null },
): { groups: T[][]; refused: T[] } {
  const groupSize = Math.max(1, Math.floor(opts.groupSize));
  const maxQ = opts.limits?.maxQuestions ?? Number.POSITIVE_INFINITY;
  const budget =
    opts.limits?.maxInputTokens != null
      ? Math.floor(opts.limits.maxInputTokens * PLAN_HEADROOM) * CHARS_PER_TOKEN - opts.baseChars
      : Number.POSITIVE_INFINITY;

  const fit: Array<{ unit: T } & UnitSize> = [];
  const refused: T[] = [];
  for (const unit of units) {
    const s = sizeOf(unit);
    if (s.chars > budget || s.questions > maxQ) refused.push(unit);
    else fit.push({ unit, ...s });
  }
  if (fit.length === 0) return { groups: [], refused };

  const byCount = Math.ceil(fit.length / groupSize);
  const totalChars = fit.reduce((n, u) => n + u.chars, 0);
  const totalQ = fit.reduce((n, u) => n + u.questions, 0);
  const byLimits = Math.max(
    Number.isFinite(maxQ) ? Math.ceil(totalQ / maxQ) : 1,
    Number.isFinite(budget) ? Math.ceil(totalChars / budget) : 1,
  );
  const target = byLimits > byCount ? Math.ceil(fit.length / byLimits) : groupSize;

  const groups: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  let qs = 0;
  for (const u of fit) {
    if (
      cur.length > 0 &&
      (cur.length >= target || chars + u.chars > budget || qs + u.questions > maxQ)
    ) {
      groups.push(cur);
      cur = [];
      chars = 0;
      qs = 0;
    }
    cur.push(u.unit);
    chars += u.chars;
    qs += u.questions;
  }
  groups.push(cur);
  return { groups, refused };
}
