/**
 * The one spend recorder (A10 #5, docs/spend-recording.md).
 *
 * Every provider call's usage is written by `recordUsage`, in one shape
 * ({@link ProviderUsage}), from one place: the adapter registry of
 * @mantle/voice, which wraps every capability (chat, stream, decision,
 * embedding, vision, image generation, speech, transcription) so no caller
 * can forget. The one provider call outside an adapter, the research tool's
 * OpenRouter SDK call, reads its raw response with `captureLlmUsage`, which
 * writes through `recordUsage` too.
 *
 * Which trace, step and prelude the usage lands on comes from context
 * (store.ts attributeUsage): the trace's totals (what rollups, the member
 * token budget and a run item's cost read) and the running step's meta (what
 * spend-by-model reads), summed over the step's calls.
 *
 * Completion tokens and embedding tokens land apart: a completion's (chat,
 * stream, decision, vision, research) in the trace's tokens in/out, which the
 * member token budget reads; an embedding call's input tokens in the trace's
 * embed tokens, which it does not (A10 #5 fix round 1). Cost is one total:
 * every priced call counts toward a run budget.
 *
 * Cost: the provider's reported cost when it gave one, else the static price
 * table (pricing.ts). Never a network call: recording spend must not spend.
 */

import { attributeUsage } from './store';
import { fallbackCostMicroUsd } from './pricing';
import { errorMessage } from '@mantle/std';

/** What kind of provider call it was. */
export type SpendCapability =
  'chat' | 'decision' | 'embedding' | 'vision' | 'image_gen' | 'tts' | 'stt' | 'research';

/** Billing units of a call that is not billed by the token. */
export type SpendUnits = {
  kind: 'audio_seconds' | 'characters' | 'images';
  count: number;
};

/** One provider call's usage: the one shape every recording takes. */
export type ProviderUsage = {
  capability: SpendCapability;
  /** The provider id the call went to (the adapter's). */
  provider: string;
  /** The model id the trace shows (step meta `model`). */
  model: string;
  /** Ids the static price table is tried on, in order, when the provider
   *  reported no cost: the requested id first, then the served one. Default:
   *  `[model]`. */
  priceAs?: readonly (string | null | undefined)[];
  /** Prompt tokens, without the cache-write tokens (a provider that counts
   *  the writes inside its prompt total, OpenRouter, takes them out in its
   *  adapter). Cache reads stay inside: the price table prices them out of
   *  this number. Undefined: a call with no token usage (speech,
   *  transcription, images); the step meta then carries no token keys. For an
   *  embedding: its input tokens, kept in the trace's embed total. */
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt tokens served from the provider's cache. Undefined: the
   *  provider has no cache reading; the step meta carries no `cache_read`. */
  cacheReadTokens?: number;
  /** Prompt tokens written into the provider's cache. Counted into the
   *  trace's input total; shown as `cache_write` on the step. */
  cacheWriteTokens?: number;
  units?: SpendUnits;
  /** USD the provider quoted for the call (OpenRouter `usage.cost`). */
  reportedCostUsd?: number;
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** The call's cost in micro-USD: reported, else the price table. */
export function usageCostMicroUsd(u: ProviderUsage): number {
  const reported = num(u.reportedCostUsd);
  if (reported > 0) return Math.round(reported * 1_000_000);
  const tokens = {
    input: num(u.inputTokens),
    output: num(u.outputTokens),
    cacheRead: num(u.cacheReadTokens),
  };
  for (const model of u.priceAs ?? [u.model]) {
    if (!model) continue;
    const cost = fallbackCostMicroUsd(model, tokens);
    if (cost > 0) return cost;
  }
  return 0;
}

/**
 * Record one provider call's usage on the trace, step or prelude in context.
 * Returns the cost it recorded, in micro-USD. Never throws.
 */
export function recordUsage(u: ProviderUsage): number {
  try {
    const costMicroUsd = usageCostMicroUsd(u);
    const input = num(u.inputTokens);
    const output = num(u.outputTokens);
    const cacheRead = num(u.cacheReadTokens);
    const cacheWrite = num(u.cacheWriteTokens);
    const meta: Record<string, string | number> = {
      model: u.model,
      provider: u.provider,
    };
    if (u.inputTokens !== undefined || u.outputTokens !== undefined) {
      meta.tokens_in = input;
      meta.tokens_out = output;
    }
    if (u.cacheReadTokens !== undefined) meta.cache_read = cacheRead;
    if (cacheWrite > 0) meta.cache_write = cacheWrite;
    if (u.units && num(u.units.count) > 0) meta[u.units.kind] = num(u.units.count);
    meta.cost_micro_usd = costMicroUsd;
    // An embedding's tokens are not completion tokens: the member token
    // budget reads tokens in + out, never these (docs/spend-recording.md).
    const tokens =
      u.capability === 'embedding'
        ? { in: 0, out: 0, cacheRead: 0, embed: input + output }
        : { in: input + cacheWrite, out: output, cacheRead, embed: 0 };
    attributeUsage({ tokens, costMicroUsd, meta });
    return costMicroUsd;
  } catch (err) {
    console.error(`[tracing] record usage: ${errorMessage(err)}`);
    return 0;
  }
}

/**
 * The raw-response reader, for the one provider call that holds an untyped
 * response instead of an adapter result: the research tool's OpenRouter SDK
 * call (Perplexity Sonar). Reads camelCase (the SDK's typed shape) and
 * snake_case (the JSON), cache reads and cache writes, then records through
 * {@link recordUsage}.
 *
 * OpenRouter's `prompt_tokens` is the whole prompt and `prompt_tokens_details`
 * a breakdown of it (its API reference: "Breakdown of prompt tokens"), so the
 * cache-write tokens are taken out of the prompt total once here, as the
 * recorder's input excludes them: the trace's input total is the provider's
 * prompt total, not that plus the writes again.
 */
export function captureLlmUsage(
  raw: unknown,
  model: string,
  opts: { capability?: SpendCapability; provider?: string } = {},
): number {
  if (!raw || typeof raw !== 'object') return 0;
  const usage = (raw as { usage?: Record<string, unknown> }).usage;
  if (!usage) return 0;
  const details = (usage.promptTokensDetails ?? usage.prompt_tokens_details ?? {}) as Record<
    string,
    unknown
  >;
  const cacheRead =
    usage.cacheReadInputTokens ??
    usage.cache_read_input_tokens ??
    usage.cached_tokens ??
    details.cachedTokens ??
    details.cached_tokens;
  const cacheWrite =
    usage.cacheCreationInputTokens ??
    usage.cache_creation_input_tokens ??
    details.cacheWriteTokens ??
    details.cache_write_tokens;
  const prompt = num(usage.promptTokens ?? usage.prompt_tokens);
  const writes = num(cacheWrite);
  return recordUsage({
    capability: opts.capability ?? 'research',
    provider: opts.provider ?? 'openrouter',
    model,
    inputTokens: Math.max(0, prompt - writes),
    outputTokens: num(usage.completionTokens ?? usage.completion_tokens),
    cacheReadTokens: num(cacheRead),
    cacheWriteTokens: writes,
    reportedCostUsd: num(usage.cost ?? usage.total_cost),
  });
}
