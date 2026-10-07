/**
 * Mammouth static catalog.
 *
 * Mammouth (https://mammouth.ai) is an OpenRouter-style aggregator: one key,
 * many vendors' models, behind an OpenAI-compatible API at
 * `https://api.mammouth.ai/v1` (`/chat/completions`, `/models`, `/embeddings`).
 * Auth is `Authorization: Bearer <key>`. Reference:
 * https://info.mammouth.ai/docs/api-quick-start/.
 *
 * Model ids are BARE (`gpt-5.4`, `claude-haiku-4-5`), not OpenRouter's
 * `vendor/model` slugs, so they can't share rows in the fallback price table
 * (`packages/tracing/src/pricing.ts`): a bare `claude-haiku-4-5` row would
 * also price the direct-Anthropic route. The adapter prices calls from THIS
 * list instead (see `mammouthCostUsd`).
 *
 * Prices are Mammouth's published per-1M rates (2026-10-03). Mammouth states
 * they are upper bounds: the real charge can be lower. Context windows are not
 * published, so `contextTokens` is left out rather than guessed.
 *
 * Not listed: `gemini-3.1-flash-image-preview` (image output, priced per
 * image) and the two `text-embedding-3-*` models (Mantle's embedder is one
 * brain-wide config; see docs/embeddings.md).
 *
 * Maintenance: Mammouth adds models often. Live discovery returns uncatalogued
 * ids too, and `pnpm -C server/web models:drift` reports them; add a row here
 * when one should carry a price and a description.
 */

import type { ChatModelInfo } from '../adapters/types';

export const MAMMOUTH_BASE_URL = 'https://api.mammouth.ai/v1';

/** The default pick: Mammouth's own router, which points at its current
 *  best-value model and is billed at that model's price. */
export const MAMMOUTH_DEFAULT_CHAT_MODEL = 'mammouth-recommended';

const TOOLS = ['function_calling'] as const;
const TOOLS_VISION = ['function_calling', 'vision'] as const;
const TOOLS_VISION_REASONING = ['function_calling', 'vision', 'reasoning'] as const;

export const MAMMOUTH_CHAT_MODELS: readonly ChatModelInfo[] = [
  {
    id: 'mammouth-recommended',
    label: 'Mammouth Recommended',
    description:
      'Mammouth picks the current best-value model (glm-5.3-flash, minimax-m3 fallback) and bills at its price. Cost is not tracked for this id because the price moves with the pick.',
    capabilities: TOOLS,
  },
  // ── Anthropic ────────────────────────────────────────────────────
  {
    id: 'claude-fable-5.1',
    label: 'Claude Fable 5.1',
    description: 'Anthropic top tier.',
    capabilities: TOOLS_VISION_REASONING,
    inputPricePer1M: 10,
    outputPricePer1M: 50,
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    description: 'Anthropic flagship.',
    capabilities: TOOLS_VISION_REASONING,
    inputPricePer1M: 4,
    outputPricePer1M: 20,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    description: 'Anthropic balanced.',
    capabilities: TOOLS_VISION_REASONING,
    inputPricePer1M: 2,
    outputPricePer1M: 10,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    description: 'Anthropic fast and cheap.',
    capabilities: TOOLS_VISION,
    inputPricePer1M: 1,
    outputPricePer1M: 5,
  },
  // ── OpenAI ───────────────────────────────────────────────────────
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    description: 'OpenAI top tier.',
    capabilities: TOOLS_VISION_REASONING,
    inputPricePer1M: 10,
    outputPricePer1M: 50,
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    description: 'OpenAI balanced.',
    capabilities: TOOLS_VISION_REASONING,
    inputPricePer1M: 2,
    outputPricePer1M: 10,
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    description: 'OpenAI small and cheap.',
    capabilities: TOOLS_VISION,
    inputPricePer1M: 0.1,
    outputPricePer1M: 0.5,
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'OpenAI previous flagship.',
    capabilities: TOOLS_VISION_REASONING,
    inputPricePer1M: 5,
    outputPricePer1M: 30,
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'OpenAI.',
    capabilities: TOOLS_VISION_REASONING,
    inputPricePer1M: 2.5,
    outputPricePer1M: 15,
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: 'OpenAI small.',
    capabilities: TOOLS_VISION,
    inputPricePer1M: 0.75,
    outputPricePer1M: 4.5,
  },
  {
    id: 'gpt-5.4-nano',
    label: 'GPT-5.4 Nano',
    description: 'OpenAI smallest.',
    capabilities: TOOLS_VISION,
    inputPricePer1M: 0.2,
    outputPricePer1M: 1.25,
  },
  // ── Google ───────────────────────────────────────────────────────
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro (preview)',
    description: 'Google flagship.',
    capabilities: TOOLS_VISION_REASONING,
    inputPricePer1M: 2,
    outputPricePer1M: 12,
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    description: 'Google fast.',
    capabilities: TOOLS_VISION,
    inputPricePer1M: 0.75,
    outputPricePer1M: 3.75,
  },
  {
    id: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    description: 'Google fast (previous).',
    capabilities: TOOLS_VISION,
    inputPricePer1M: 1.5,
    outputPricePer1M: 7.5,
  },
  // ── xAI ──────────────────────────────────────────────────────────
  {
    id: 'grok-4.7',
    label: 'Grok 4.7',
    description: 'xAI flagship.',
    capabilities: TOOLS_VISION_REASONING,
    inputPricePer1M: 2,
    outputPricePer1M: 6,
  },
  // ── Open-weight and other vendors ────────────────────────────────
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: 'DeepSeek flagship.',
    capabilities: ['function_calling', 'reasoning'],
    inputPricePer1M: 1.74,
    outputPricePer1M: 3.48,
  },
  {
    id: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    description: 'DeepSeek fast and cheap.',
    capabilities: TOOLS,
    inputPricePer1M: 0.22,
    outputPricePer1M: 0.66,
  },
  {
    id: 'glm-5.3',
    label: 'GLM 5.3',
    description: 'Z.ai flagship.',
    capabilities: TOOLS,
    inputPricePer1M: 1.4,
    outputPricePer1M: 4.4,
  },
  {
    id: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    description: 'Z.ai fast. The current target of mammouth-recommended.',
    capabilities: TOOLS,
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.5,
  },
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    description: 'Moonshot flagship.',
    capabilities: TOOLS,
    inputPricePer1M: 3,
    outputPricePer1M: 15,
  },
  {
    id: 'kimi-k2.6',
    label: 'Kimi K2.6',
    description: 'Moonshot.',
    capabilities: TOOLS,
    inputPricePer1M: 0.73,
    outputPricePer1M: 3.49,
  },
  {
    id: 'minimax-m3',
    label: 'MiniMax M3',
    description: 'MiniMax.',
    capabilities: TOOLS,
    inputPricePer1M: 0.3,
    outputPricePer1M: 1.2,
  },
  {
    id: 'qwen3.7-plus',
    label: 'Qwen 3.7 Plus',
    description: 'Alibaba Qwen.',
    capabilities: TOOLS,
    inputPricePer1M: 0.4,
    outputPricePer1M: 1.6,
  },
  {
    id: 'qwen3.8-27b',
    label: 'Qwen 3.8 27B',
    description: 'Alibaba Qwen, open weights.',
    capabilities: TOOLS,
    inputPricePer1M: 0.4,
    outputPricePer1M: 2.55,
  },
  {
    id: 'qwen3.8-flash',
    label: 'Qwen 3.8 Flash',
    description: 'Alibaba Qwen, fast.',
    capabilities: TOOLS,
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.47,
  },
  {
    id: 'mistral-medium-3-5',
    label: 'Mistral Medium 3.5',
    description: 'Mistral.',
    capabilities: TOOLS,
    inputPricePer1M: 1.5,
    outputPricePer1M: 7.5,
  },
  {
    id: 'mistral-small-3.2-24b-instruct',
    label: 'Mistral Small 3.2 24B',
    description: 'Mistral small, open weights.',
    capabilities: TOOLS,
    inputPricePer1M: 0.1,
    outputPricePer1M: 0.3,
  },
  {
    id: 'llama-4-maverick',
    label: 'Llama 4 Maverick',
    description: 'Meta, open weights.',
    capabilities: TOOLS,
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.6,
  },
  // ── Perplexity (web-grounded) ────────────────────────────────────
  {
    id: 'sonar-pro',
    label: 'Sonar Pro',
    description:
      'Perplexity web-grounded answers. Token price only; any per-search fee is not tracked.',
    inputPricePer1M: 3,
    outputPricePer1M: 15,
  },
  {
    id: 'sonar-deep-research',
    label: 'Sonar Deep Research',
    description: 'Perplexity multi-step web research. Slow. Token price only.',
    inputPricePer1M: 2,
    outputPricePer1M: 8,
  },
];

/**
 * Cost of one Mammouth call in USD, from the catalog's published rate. Returns
 * undefined for an uncatalogued id or `mammouth-recommended` (no fixed price),
 * so the trace falls back to its own table rather than recording a wrong
 * number. Cached input tokens are priced at the full input rate: Mammouth
 * publishes no cache rate, and its listed prices are already upper bounds.
 */
export function mammouthCostUsd(
  model: string,
  tokensIn: number | undefined,
  tokensOut: number | undefined,
): number | undefined {
  const m = MAMMOUTH_CHAT_MODELS.find((x) => x.id === model.toLowerCase());
  if (!m || m.inputPricePer1M == null || m.outputPricePer1M == null) return undefined;
  if (tokensIn == null && tokensOut == null) return undefined;
  return ((tokensIn ?? 0) * m.inputPricePer1M + (tokensOut ?? 0) * m.outputPricePer1M) / 1_000_000;
}
