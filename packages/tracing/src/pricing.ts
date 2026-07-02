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
  'anthropic/claude-sonnet-5': { input: 0.000002, output: 0.00001, cacheRead: 0.0000002 },
  'anthropic/claude-sonnet-4.6': { input: 0.000003, output: 0.000015, cacheRead: 0.0000003 },
  'anthropic/claude-opus-4.7': { input: 0.000015, output: 0.000075, cacheRead: 0.0000015 },
  'anthropic/claude-opus-4.7-fast': { input: 0.00003, output: 0.00015, cacheRead: 0.000003 },

  // OpenAI via OpenRouter
  'openai/gpt-5.5': { input: 0.000005, output: 0.00003 },
  'openai/gpt-5.4': { input: 0.0000025, output: 0.000015 },
  'openai/gpt-5.4-mini': { input: 0.00000075, output: 0.0000045 },
  'openai/gpt-5.4-nano': { input: 0.0000002, output: 0.00000125 },
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

  // Direct-Anthropic adapters (vision / document) call the Anthropic API
  // natively and pass the BARE catalog id (claude-sonnet-4-6), not the dotted
  // `anthropic/claude-sonnet-4.6` OpenRouter slug — so key both ways or a
  // direct Claude vision/document worker prices at $0. Same rates as above.
  'claude-haiku-4-5': { input: 0.0000008, output: 0.000004, cacheRead: 0.00000008 },
  'claude-sonnet-5': { input: 0.000002, output: 0.00001, cacheRead: 0.0000002 },
  'claude-sonnet-4-6': { input: 0.000003, output: 0.000015, cacheRead: 0.0000003 },
  'claude-opus-4-7': { input: 0.000015, output: 0.000075, cacheRead: 0.0000015 },

  // Direct-Google (Gemini) vision/document workers pass bare ids too.
  'gemini-2.5-flash': { input: 0.0000003, output: 0.0000025 },
  'gemini-2.5-pro': { input: 0.00000125, output: 0.00001 },

  // DeepSeek
  'deepseek/deepseek-chat': { input: 0.00000027, output: 0.0000011 },

  // Google
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
