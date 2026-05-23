/**
 * Pull token + cost data off an OpenRouter chat response and roll it into a
 * trace step (which bubbles to the trace total). The SDK exposes camelCase on
 * the typed shape (`promptTokens`, etc.) but some routes return snake_case in
 * the underlying JSON; we read both. Cost comes from `usage.cost` when the
 * route reports it (the accurate path — includes provider surcharges like
 * Perplexity's per-search fee), else falls back to the static price table.
 *
 * Lives here (not in agent-runtime) so any caller with a trace step can use it
 * — including tool handlers in @mantle/tools, which can't import agent-runtime
 * without a dependency cycle.
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
