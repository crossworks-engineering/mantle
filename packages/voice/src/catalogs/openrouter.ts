/**
 * Curated OpenRouter chat catalog — Mantle's headline picks.
 *
 * OpenRouter serves 300+ chat models across every major provider. We
 * don't try to mirror that — the full live catalog is fetched at
 * runtime by `discoverModels` against `https://openrouter.ai/api/v1/models`
 * (keyless). This static list is what the worker form's model dropdown
 * renders BEFORE discovery completes, and the fallback when discovery
 * fails (rare; OR's /models endpoint is among the most reliable in
 * the catalogue).
 *
 * Pick criteria — what makes it onto this list:
 *   - The model the project's default workers ship pointing at, OR
 *   - A current top-tier headline from each major lab (Anthropic,
 *     OpenAI, Google, xAI), OR
 *   - A notable open-weights model that's frequently asked for
 *     (DeepSeek's reasoning lines, Llama 4).
 *
 * Capabilities + pricing here mirror the source-of-truth pricing
 * table in [packages/tracing/src/pricing.ts](../../tracing/src/pricing.ts).
 * Keep them aligned when models shift — the chat-adapter UI reads
 * these for the dropdown hints, and tracing reads pricing.ts for the
 * fallback cost calculation. Diverging would let a model show one
 * price in the dropdown and bill at a different one.
 */

import type { ChatModelInfo, VisionModelInfo } from '../adapters/types';

/** OpenRouter API base. The SDK constructs this internally too; we
 *  expose it for the catalogue + discovery so both paths agree. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** A small curated set of OpenRouter chat models we vouch for as
 *  defaults. The full live catalog comes from discovery; this is the
 *  "before the network call returns" picture. */
export const OPENROUTER_CHAT_MODELS: readonly ChatModelInfo[] = [
  // Anthropic — the responder's default lives here.
  {
    id: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet 5',
    description:
      'Anthropic flagship. Strong reasoning + tool use, 1M context. Default for the responder and Saskia. Supports prompt caching (~10× cheaper on cache hits).',
    contextTokens: 1_000_000,
    capabilities: ['reasoning', 'function_calling', 'vision'],
    inputPricePer1M: 2,
    outputPricePer1M: 10,
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    label: 'Claude Sonnet 4.6',
    description: 'Previous-generation Sonnet. 1M context; supports prompt caching.',
    contextTokens: 1_000_000,
    capabilities: ['reasoning', 'function_calling', 'vision'],
    inputPricePer1M: 3,
    outputPricePer1M: 15,
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    description:
      'Anthropic small/fast. Cheap, fast, 200K context. Default for the extractor + summarizer. Supports prompt caching.',
    contextTokens: 200_000,
    capabilities: ['function_calling', 'vision'],
    inputPricePer1M: 0.8,
    outputPricePer1M: 4,
  },
  {
    id: 'anthropic/claude-opus-4.7',
    label: 'Claude Opus 4.7',
    description:
      'Anthropic top-tier. Highest capability, highest price. 1M context. Use when the responder needs to chew on something hard.',
    contextTokens: 1_000_000,
    capabilities: ['reasoning', 'function_calling', 'vision'],
    inputPricePer1M: 15,
    outputPricePer1M: 75,
  },
  // OpenAI — headline picks.
  {
    id: 'openai/gpt-5',
    label: 'GPT-5',
    description: 'OpenAI flagship. Strong all-rounder, native vision + tool use. 256K context.',
    contextTokens: 256_000,
    capabilities: ['reasoning', 'function_calling', 'vision'],
    inputPricePer1M: 5,
    outputPricePer1M: 15,
  },
  {
    id: 'openai/gpt-4o',
    label: 'GPT-4o',
    description: 'OpenAI multimodal workhorse. Still widely used for cost reasons. 128K context.',
    contextTokens: 128_000,
    capabilities: ['function_calling', 'vision'],
    inputPricePer1M: 2.5,
    outputPricePer1M: 10,
  },
  {
    id: 'openai/gpt-4o-mini',
    label: 'GPT-4o Mini',
    description:
      'OpenAI cheap fast model. Good extractor candidate when keeping costs low matters more than precision.',
    contextTokens: 128_000,
    capabilities: ['function_calling', 'vision'],
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.6,
  },
  // Google — Gemini 2.5+.
  {
    id: 'google/gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    description:
      'Google top-tier with 2M context. Strong long-document handling; implicit prompt caching on Gemini 2.5+.',
    contextTokens: 2_000_000,
    capabilities: ['reasoning', 'function_calling', 'vision'],
    inputPricePer1M: 1.25,
    outputPricePer1M: 10,
  },
  {
    id: 'google/gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description:
      'Google fast/cheap. 1M context, implicit caching. Good fit for extractor + summarizer when not using Anthropic.',
    contextTokens: 1_000_000,
    capabilities: ['function_calling', 'vision'],
    inputPricePer1M: 0.3,
    outputPricePer1M: 2.5,
  },
  // xAI.
  {
    id: 'x-ai/grok-4',
    label: 'Grok 4',
    description:
      'xAI flagship. 256K context, vision-capable. Real-time web access on some variants. Automatic prompt caching server-side.',
    contextTokens: 256_000,
    capabilities: ['reasoning', 'function_calling', 'vision'],
    inputPricePer1M: 3,
    outputPricePer1M: 15,
  },
  // DeepSeek — open-weights reasoning.
  {
    id: 'deepseek/deepseek-v3.1',
    label: 'DeepSeek V3.1',
    description:
      'Open-weights MoE. Strong reasoning at low price; popular for cost-sensitive workloads.',
    contextTokens: 128_000,
    capabilities: ['function_calling'],
    inputPricePer1M: 0.27,
    outputPricePer1M: 1.1,
  },
  // Meta — Llama 4 if/when added; placeholder pricing.
  {
    id: 'meta-llama/llama-4-maverick',
    label: 'Llama 4 Maverick',
    description:
      'Open-weights from Meta. Reasonable cost, broad capability. Pricing varies by sub-provider OR routes to.',
    contextTokens: 256_000,
    capabilities: ['function_calling', 'vision'],
    inputPricePer1M: 0.5,
    outputPricePer1M: 1.5,
  },
];

/** Curated vision-capable OpenRouter routes for the Vision + Document worker
 *  dropdowns (before discovery returns the live image-input list). The
 *  Anthropic + Gemini routes also support native PDF, so they back the
 *  Document worker's `extractDocument` path; gpt-4o is image-only here. */
export const OPENROUTER_VISION_MODELS: readonly VisionModelInfo[] = [
  {
    id: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet 5',
    description: 'Strong document + table reading; native PDF. Great default for invoices.',
    contextTokens: 1_000_000,
    inputPricePer1M: 2,
    outputPricePer1M: 10,
    tier: 'balanced',
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    label: 'Claude Sonnet 4.6',
    description: 'Previous-generation Sonnet vision; native PDF.',
    contextTokens: 1_000_000,
    inputPricePer1M: 3,
    outputPricePer1M: 15,
    tier: 'balanced',
  },
  {
    id: 'anthropic/claude-opus-4.7',
    label: 'Claude Opus 4.7',
    description: 'Top-tier vision/document fidelity; native PDF. Highest cost.',
    contextTokens: 1_000_000,
    inputPricePer1M: 15,
    outputPricePer1M: 75,
    tier: 'quality',
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    description: 'Cheap + fast vision; native PDF. Good for high-volume describe/OCR.',
    contextTokens: 200_000,
    inputPricePer1M: 0.8,
    outputPricePer1M: 4,
    tier: 'fast',
  },
  {
    id: 'google/gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    description: 'Google multimodal; native PDF. Strong on dense layouts.',
    contextTokens: 1_000_000,
    inputPricePer1M: 1.25,
    outputPricePer1M: 10,
    tier: 'balanced',
  },
  {
    id: 'openai/gpt-4o',
    label: 'GPT-4o',
    description: 'OpenAI multimodal (images). PDFs fall back to page OCR via OpenRouter.',
    contextTokens: 128_000,
    inputPricePer1M: 2.5,
    outputPricePer1M: 10,
    tier: 'balanced',
  },
];
