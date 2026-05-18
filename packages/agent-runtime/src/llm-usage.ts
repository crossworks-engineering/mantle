/**
 * Pull token + cost data off an OpenRouter chat response and roll it
 * into the active trace step (which bubbles to the trace). The SDK
 * exposes camelCase on the typed shape (`promptTokens`, etc.) but some
 * routes return snake_case in the underlying JSON; we read both.
 */

import { fallbackCostMicroUsd, type StepHandle } from '@mantle/tracing';

export function captureLlmUsage(handle: StepHandle, result: unknown, model: string): void {
  if (!result || typeof result !== 'object') return;
  const usage = (result as { usage?: Record<string, unknown> }).usage;
  if (!usage) return;
  const promptTokens = num(usage.promptTokens ?? usage.prompt_tokens);
  const completionTokens = num(usage.completionTokens ?? usage.completion_tokens);
  const cacheReadTokens = num(
    usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens,
  );
  handle.addTokens({
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
  handle.addCost(microUsd);
  handle.setMeta({
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
