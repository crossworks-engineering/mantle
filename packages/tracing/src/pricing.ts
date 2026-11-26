/**
 * Fallback model pricing: only used when the provider doesn't return
 * usage.cost on the response. Best-effort; a model with no row here costs
 * $0 and its call is marked unpriced (spend.ts). Live pricing is preferred.
 *
 * Prices are USD per token (not per million). Stored that way so we
 * never accidentally fence-post-error a million.
 *
 * ONE ROW PER MODEL. The lookup does not read the vendor prefix, a leading
 * `~`, or the dot/dash spelling of a version (`priceKey`), so
 * `anthropic/claude-sonnet-4.6` (OpenRouter) and `claude-sonnet-4-6`
 * (Anthropic direct) are one row, and so are `openai/text-embedding-3-large`
 * and the bare `text-embedding-3-large` a direct OpenAI route records. Do
 * not add a second row for another spelling: `pricing.test.ts` fails on two
 * rows with one key.
 */

type PricePerToken = {
  input: number;
  output: number;
  cacheRead?: number;
};

/** Billing units of a call that is not billed by the token. */
export type UnitKind = 'audio_seconds' | 'characters' | 'images';

/** The list price of one unit, for a model billed by the unit. */
type PricePerUnit = { kind: UnitKind; usd: number };

const PRICING: Record<string, PricePerToken> = {
  // Anthropic (the OpenRouter slug; the direct id `claude-sonnet-5-5` is the
  // same row). The 5.5 rows: Anthropic's API price list, 2026-11-03, the same
  // on OpenRouter's list, 2026-11-26. Haiku 5.5 is the rate to a 100k-token
  // prompt; a longer prompt costs more ($0.50 / $2.50).
  'anthropic/claude-sonnet-5.5': { input: 0.000002, output: 0.00001, cacheRead: 0.0000001 },
  'anthropic/claude-haiku-5.5': { input: 0.0000001, output: 0.0000005, cacheRead: 0.00000001 },
  'anthropic/claude-opus-5.5': { input: 0.000004, output: 0.00002, cacheRead: 0.0000002 },
  'anthropic/claude-haiku-4.5': { input: 0.0000008, output: 0.000004, cacheRead: 0.00000008 },
  'anthropic/claude-sonnet-5': { input: 0.000002, output: 0.00001, cacheRead: 0.0000002 },
  'anthropic/claude-sonnet-4.6': { input: 0.000003, output: 0.000015, cacheRead: 0.0000003 },
  'anthropic/claude-opus-4.7': { input: 0.000015, output: 0.000075, cacheRead: 0.0000015 },
  'anthropic/claude-opus-4.7-fast': { input: 0.00003, output: 0.00015, cacheRead: 0.000003 },

  // OpenAI (the OpenRouter slug; a direct route's bare id is the same row).
  // GPT-6 (OpenRouter list, 2026-11-10): the base rate; a prompt over 272k
  // tokens costs more, which OpenRouter's reported cost carries.
  'openai/gpt-6-astra': { input: 0.00001, output: 0.00005 },
  'openai/gpt-6.1-sol': { input: 0.000002, output: 0.00001 },
  // The shipped worker and agent models (OpenRouter list, 2026-11-26): the
  // base rate, as above.
  'openai/gpt-6.1-terra': { input: 0.000001, output: 0.000005, cacheRead: 0.00000005 },
  'openai/gpt-6-luna': { input: 0.0000001, output: 0.0000005, cacheRead: 0.00000001 },
  'openai/gpt-5.5': { input: 0.000005, output: 0.00003 },
  'openai/gpt-5.4': { input: 0.0000025, output: 0.000015 },
  'openai/gpt-5.4-mini': { input: 0.00000075, output: 0.0000045 },
  'openai/gpt-5.4-nano': { input: 0.0000002, output: 0.00000125 },
  'openai/gpt-4o': { input: 0.0000025, output: 0.00001 },
  'openai/gpt-4o-mini': { input: 0.00000015, output: 0.0000006 },
  'openai/text-embedding-3-small': { input: 0.00000002, output: 0 },
  'openai/text-embedding-3-large': { input: 0.00000013, output: 0 },

  // DeepSeek
  'deepseek/deepseek-chat': { input: 0.00000027, output: 0.0000011 },

  // Google (a direct Gemini route's bare id is the same row).
  // Gemini 3.8 Flash, the shipped read worker (OpenRouter list, 2026-11-26).
  'google/gemini-3.8-flash': { input: 0.000000825, output: 0.000004125, cacheRead: 0.0000000825 },
  'google/gemini-2.5-flash': { input: 0.0000003, output: 0.0000025 },
  'google/gemini-2.5-pro': { input: 0.00000125, output: 0.00001 },

  // Perplexity Sonar (via OpenRouter) — used by the web_search tool. Token
  // rates only; Sonar also bills a per-search surcharge that this table can't
  // model, so the reported `usage.cost` (requested via usage:{include:true})
  // is the accurate path and this is just the fallback floor.
  'perplexity/sonar': { input: 0.000001, output: 0.000001 },
  'perplexity/sonar-pro': { input: 0.000003, output: 0.000015 },
  'perplexity/sonar-reasoning': { input: 0.000001, output: 0.000005 },
  'perplexity/sonar-reasoning-pro': { input: 0.000002, output: 0.000008 },

  // xAI via OpenRouter. `~x-ai/grok-latest` is the auto-updating alias and the
  // shipped agent default; it resolves to the current flagship (Grok 4.7 as of
  // 2026-09-22) and is priced the same, so both keys carry the one rate. An
  // alias never appears in a usage row under its target's id, so it needs its
  // own entry or every agent turn prices at $0 on the fallback path.
  '~x-ai/grok-latest': { input: 0.0000016, output: 0.0000048 },
  'x-ai/grok-4.7': { input: 0.0000016, output: 0.0000048 },

  // Google Gemini Flash Lite — the always-on indexing workers' model.
  'google/gemini-3.5-flash-lite': { input: 0.0000003, output: 0.0000025 },
  'google/gemini-3.1-flash-lite': { input: 0.00000025, output: 0.0000015 },

  // TypeSafe Jev (via OpenRouter's decisions endpoint) — the `decider` worker.
  // Input-only billing; answers are free. The reported `usage.cost` is the
  // accurate path, this is the fallback floor. `~typesafe/jev-latest` is the
  // auto-updating alias of the same model.
  'typesafe/jev-1.13': { input: 0.000000042, output: 0 },
  'typesafe/jev-1.14': { input: 0.000000042, output: 0 },
  '~typesafe/jev-latest': { input: 0.000000042, output: 0 },
  // The other decision models that answer a full-size request (groups A and
  // B of the 2026-10-30 probe; OpenRouter list prices that day). A call that
  // reports no `usage.cost` prices from these, as a direct route such as
  // Foundry will. Span-02 bills the state once per question, so its token
  // count is already the large one.
  'perplexity/pplx-decider-v1.2': { input: 0.00000002, output: 0 },
  'microsoft/microsoft-decision-1': { input: 0.000000042, output: 0 },
  'nace-ai/drex-v1.5': { input: 0.00000004, output: 0 },
  'cloudflare/clef-omni': { input: 0.00000015, output: 0 },
  'openai/gpt-6-luna-decisions': { input: 0.0000001, output: 0 },
  'respan/span-02': { input: 0.00000001, output: 0 },
};

/**
 * Models billed by the unit, where no reply carries the cost: speech (a raw
 * audio reply, on OpenRouter too) and xAI's transcription. Same key rule as
 * PRICING.
 */
const UNIT_PRICING: Record<string, PricePerUnit> = {
  // xAI speech: $15 per 1M characters (xAI price list and OpenRouter list,
  // 2026-11-26). `grok-voice-latest` is the direct route's alias.
  'x-ai/grok-voice-tts-1.0': { kind: 'characters', usd: 0.000015 },
  'grok-voice-latest': { kind: 'characters', usd: 0.000015 },
  // xAI transcription over REST: $0.10 per hour of audio (xAI price list,
  // 2026-11-26).
  'grok-stt': { kind: 'audio_seconds', usd: 0.1 / 3600 },
};

/**
 * The key a model is priced by: lowercase, without a leading `~` (an
 * auto-updating alias), without the vendor prefix, a version's dots as
 * dashes. One model, one key, however the provider spells it.
 */
export function priceKey(model: string): string {
  const id = model.toLowerCase().replace(/^~/, '');
  return id.slice(id.lastIndexOf('/') + 1).replaceAll('.', '-');
}

function byKey<T>(table: Record<string, T>): Map<string, T> {
  return new Map(Object.entries(table).map(([id, price]) => [priceKey(id), price]));
}

const TOKEN_PRICES = byKey(PRICING);
const UNIT_PRICES = byKey(UNIT_PRICING);

/** The ids of the price rows, for the test that no two share a key. */
export const PRICED_MODEL_IDS: readonly string[] = [
  ...Object.keys(PRICING),
  ...Object.keys(UNIT_PRICING),
];

/**
 * A call that costs nothing by its route: a self-hosted model (the `local`
 * provider: Ollama chat, the bundled embedder) or a provider's free variant
 * (an id ending `:free`). The whole list; anything else with no price is
 * unpriced, not free.
 */
export function isFreeCall(provider: string, model: string): boolean {
  return provider === 'local' || model.toLowerCase().endsWith(':free');
}

/**
 * The list price of a call in micro-USD, or null when the table has no row
 * for the model (for a call billed by the unit: no row of that unit).
 */
export function listPriceMicroUsd(
  model: string,
  tokens: { input: number; output: number; cacheRead?: number },
  units?: { kind: UnitKind; count: number },
): number | null {
  const key = priceKey(model);
  const price = TOKEN_PRICES.get(key);
  const unitRow = UNIT_PRICES.get(key);
  const unit = unitRow && units && units.kind === unitRow.kind && units.count > 0 ? unitRow : null;
  if (!price && !unit) return null;
  let usd = 0;
  if (price) {
    const cacheRate = price.cacheRead ?? price.input;
    const cacheTokens = tokens.cacheRead ?? 0;
    const freshInput = Math.max(0, tokens.input - cacheTokens);
    usd += freshInput * price.input + cacheTokens * cacheRate + tokens.output * price.output;
  }
  if (unit && units) usd += units.count * unit.usd;
  return Math.round(usd * 1_000_000);
}

/**
 * Compute cost in micro-USD from a model slug + token counts. Returns 0
 * if the model isn't in the table.
 */
export function fallbackCostMicroUsd(
  model: string,
  tokens: { input: number; output: number; cacheRead?: number },
): number {
  return listPriceMicroUsd(model, tokens) ?? 0;
}
