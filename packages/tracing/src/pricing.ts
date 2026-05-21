/**
 * Fallback model pricing — only used when the provider doesn't return
 * usage.cost on the response. Best-effort; missing slugs return 0 and
 * traces show $0.00 for that step. Live pricing is preferred.
 *
 * Prices are USD per token (not per million). Stored that way so we
 * never accidentally fence-post-error a million.
 */

type PricePerToken = {
  input: number;
  output: number;
  cacheRead?: number;
};

const PRICING: Record<string, PricePerToken> = {
  // Anthropic via OpenRouter
  'anthropic/claude-haiku-4.5': { input: 0.0000008, output: 0.000004, cacheRead: 0.00000008 },
  'anthropic/claude-sonnet-4.6': { input: 0.000003, output: 0.000015, cacheRead: 0.0000003 },
  'anthropic/claude-opus-4.7': { input: 0.000015, output: 0.000075, cacheRead: 0.0000015 },
  'anthropic/claude-opus-4.7-fast': { input: 0.00003, output: 0.00015, cacheRead: 0.000003 },

  // OpenAI via OpenRouter
  'openai/gpt-4o': { input: 0.0000025, output: 0.00001 },
  'openai/gpt-4o-mini': { input: 0.00000015, output: 0.0000006 },
  'openai/text-embedding-3-small': { input: 0.00000002, output: 0 },
  'openai/text-embedding-3-large': { input: 0.00000013, output: 0 },

  // Direct-OpenAI adapters (vision / image-gen / TTS·STT) call the OpenAI
  // API natively and pass the BARE model id, not the `openai/` OpenRouter
  // slug. Same price, keyed both ways so fallback pricing resolves for a
  // direct vision worker (e.g. the default gpt-4o-mini librarian) instead of
  // silently reading $0. See docs/file-ingestion.md V1.
  'gpt-4o': { input: 0.0000025, output: 0.00001 },
  'gpt-4o-mini': { input: 0.00000015, output: 0.0000006 },

  // DeepSeek
  'deepseek/deepseek-chat': { input: 0.00000027, output: 0.0000011 },

  // Google
  'google/gemini-2.5-flash': { input: 0.0000003, output: 0.0000025 },
  'google/gemini-2.5-pro': { input: 0.00000125, output: 0.00001 },
};

/**
 * Compute cost in micro-USD from a model slug + token counts. Returns 0
 * if the model isn't in the table. The model is normalised to lowercase
 * before lookup, since some routes inject case variants.
 */
export function fallbackCostMicroUsd(
  model: string,
  tokens: { input: number; output: number; cacheRead?: number },
): number {
  const price = PRICING[model.toLowerCase()];
  if (!price) return 0;
  const cacheRate = price.cacheRead ?? price.input;
  const cacheTokens = tokens.cacheRead ?? 0;
  const freshInput = Math.max(0, tokens.input - cacheTokens);
  const usd =
    freshInput * price.input + cacheTokens * cacheRate + tokens.output * price.output;
  return Math.round(usd * 1_000_000);
}
