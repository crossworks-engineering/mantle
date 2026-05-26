/**
 * Two helpers that turn provider chat-completion responses into trace
 * step metadata + token + cost rollups:
 *
 *   - `captureLlmUsage(sink, raw, model)`: the raw-response reader.
 *     Pulls token + cost data off whatever the provider returned. Reads
 *     both camelCase (OpenRouter SDK typed shape) and snake_case
 *     (underlying JSON variants). Used by callers that still hold the
 *     untyped raw response — Perplexity-via-OR in the research tool
 *     handler being the canonical example.
 *
 *   - `recordChatUsage(sink, result, model)`: the typed-result reader.
 *     Operates on the normalised `ChatResult` shape returned by every
 *     chat adapter post-Phase-3. Same trace meta keys, same cost
 *     fallback, less guessing about field names. Preferred for any
 *     call site that goes through the adapter registry.
 *
 * Both write the same setMeta keys so the /debug dashboard doesn't
 * need to know which helper a given step used.
 *
 * Lives here (not in agent-runtime) so any caller with a trace step
 * can use it — including tool handlers in @mantle/tools, which can't
 * import agent-runtime without a dependency cycle.
 */

import { fallbackCostMicroUsd } from './pricing';

/**
 * The minimal surface a usage capture needs from a trace step. Both the full
 * `StepHandle` and the narrowed step passed to tool handlers satisfy it.
 */
export type LlmUsageSink = {
  setMeta(m: Record<string, unknown>): void;
  addTokens(delta: { input?: number; output?: number; cacheRead?: number }): void;
  addCost(microUsd: number): void;
};

export function captureLlmUsage(sink: LlmUsageSink, result: unknown, model: string): void {
  if (!result || typeof result !== 'object') return;
  const usage = (result as { usage?: Record<string, unknown> }).usage;
  if (!usage) return;
  const promptTokens = num(usage.promptTokens ?? usage.prompt_tokens);
  const completionTokens = num(usage.completionTokens ?? usage.completion_tokens);
  const cacheReadTokens = num(
    usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens,
  );
  sink.addTokens({
    input: promptTokens,
    output: completionTokens,
    cacheRead: cacheReadTokens,
  });
  // OpenRouter sometimes returns `cost` (USD) on the usage object.
  const reportedUsdCost = num(usage.cost ?? usage.total_cost);
  const microUsd =
    reportedUsdCost > 0
      ? Math.round(reportedUsdCost * 1_000_000)
      : fallbackCostMicroUsd(model, {
          input: promptTokens,
          output: completionTokens,
          cacheRead: cacheReadTokens,
        });
  sink.addCost(microUsd);
  sink.setMeta({
    model,
    tokens_in: promptTokens,
    tokens_out: completionTokens,
    cache_read: cacheReadTokens,
    cost_micro_usd: microUsd,
  });
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * The typed-result reader. Operates on the normalised `ChatResult`
 * shape that every chat adapter returns post-Phase-3 (see
 * `@mantle/voice/adapters/types.ts`). Same setMeta keys as
 * {@link captureLlmUsage} so dashboards don't care which helper a
 * given step used.
 *
 * Why a separate helper rather than overloading `captureLlmUsage`:
 *   - Type safety. `ChatResult` is a fixed shape; reading typed
 *     fields avoids the `usage?.cacheReadInputTokens ?? cache_read_input_tokens
 *     ?? cached_tokens` field-name lottery the raw helper carries.
 *   - Provenance clarity. A grep for `recordChatUsage` lists every
 *     call site that went through the adapter registry; a grep for
 *     `captureLlmUsage` lists every legacy / non-adapter call site.
 *   - Cost path. `result.reportedCostUsd` is the typed-result way to
 *     ask "did the provider quote a cost?" — equivalent to the raw
 *     helper's `usage.cost ?? usage.total_cost` lookup but explicit.
 */
export type ChatUsageResult = {
  /** Echo of the model the provider actually served (may differ from
   *  the requested id — e.g. HF :fastest routing). Recorded into the
   *  step's `model` meta key. */
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** USD cost reported by the provider (OpenRouter today). When
   *  absent, the helper falls back to the static price table. */
  reportedCostUsd?: number;
};

export function recordChatUsage(
  sink: LlmUsageSink,
  result: ChatUsageResult,
  /** The model id the caller *requested* — distinct from the model
   *  the provider echoed back in `result.model`. The latter goes into
   *  the meta for trace inspection; the former is what the static
   *  price table is keyed on. */
  requestedModel: string,
): void {
  const promptTokens = numOrZero(result.tokensIn);
  const completionTokens = numOrZero(result.tokensOut);
  const cacheReadTokens = numOrZero(result.cacheReadTokens);
  const cacheWriteTokens = numOrZero(result.cacheWriteTokens);
  sink.addTokens({
    input: promptTokens,
    output: completionTokens,
    cacheRead: cacheReadTokens,
  });
  // Cache writes get folded into `tokensIn` by adapters that don't
  // distinguish (every adapter except anthropic-chat / openrouter-chat).
  // For the two adapters that DO surface cacheWriteTokens distinctly,
  // we fold them in here too so trace totals stay consistent — the
  // separate meta key below keeps the breakdown inspectable.
  if (cacheWriteTokens > 0) {
    sink.addTokens({ input: cacheWriteTokens });
  }
  const reportedUsd = numOrZero(result.reportedCostUsd);
  const microUsd =
    reportedUsd > 0
      ? Math.round(reportedUsd * 1_000_000)
      : fallbackCostMicroUsd(requestedModel, {
          input: promptTokens,
          output: completionTokens,
          cacheRead: cacheReadTokens,
        });
  sink.addCost(microUsd);
  sink.setMeta({
    model: result.model || requestedModel,
    tokens_in: promptTokens,
    tokens_out: completionTokens,
    cache_read: cacheReadTokens,
    ...(cacheWriteTokens > 0 ? { cache_write: cacheWriteTokens } : {}),
    cost_micro_usd: microUsd,
  });
}

function numOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
