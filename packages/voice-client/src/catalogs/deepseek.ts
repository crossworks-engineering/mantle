/**
 * DeepSeek static catalog.
 *
 * DeepSeek's API is OpenAI-compatible — same `/chat/completions` shape,
 * snake_case fields, tool_calls + tool_call_id, image_url for vision.
 * The adapter at `../adapters/deepseek-chat.ts` reuses the shared
 * `toOpenAICompatMessages` / `extractOpenAICompatToolCalls` helpers
 * from openai-compat.ts.
 *
 * **One non-standard quirk worth flagging here:** DeepSeek surfaces
 * prompt-cache hits as TOP-LEVEL `usage.prompt_cache_hit_tokens` and
 * `usage.prompt_cache_miss_tokens` fields — NOT the OpenAI-compat
 * `usage.prompt_tokens_details.cached_tokens` shape that xAI / HF
 * sub-providers use. The adapter handles this in its own usage
 * extraction; can't reuse a shared helper for this part. Reference:
 * https://api-docs.deepseek.com/guides/kv_cache.
 *
 * Caching is AUTOMATIC: no cache_control markers needed. Prefix
 * matches trigger cache hits server-side, billed at ~2% of the
 * fresh-input rate (an enormous discount vs. Anthropic's ~10%).
 *
 * Maintenance: when DeepSeek deprecates `deepseek-chat` /
 * `deepseek-reasoner` (announced for 2026-07-24), drop them from this
 * list — they're kept here for now so existing workers that picked
 * them keep showing in the dropdown.
 */

import type { ChatModelInfo } from '../adapters/types';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export const DEEPSEEK_CHAT_MODELS: readonly ChatModelInfo[] = [
  // ── Current generation (V4) ──────────────────────────────────────
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description:
      'DeepSeek flagship. Strong reasoning + tool use, 1M context. ' +
      'Automatic prompt caching surfaces ~2% cache-hit rate (extreme ' +
      'savings on re-sent prefixes). Promo pricing through 2026-05-31.',
    contextTokens: 1_000_000,
    capabilities: ['reasoning', 'function_calling'],
    inputPricePer1M: 0.435,
    outputPricePer1M: 0.87,
  },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description:
      'DeepSeek fast/cheap. 1M context, automatic prompt caching. ' +
      'Bargain pricing — fits well for high-volume extractor / ' +
      'summarizer workloads.',
    contextTokens: 1_000_000,
    capabilities: ['function_calling'],
    inputPricePer1M: 0.14,
    outputPricePer1M: 0.28,
  },
  // ── Legacy aliases (deprecated 2026-07-24) ───────────────────────
  // Kept so existing workers configured for these slugs keep working
  // until the deprecation date. New workers should pick a V4 model
  // above instead.
  {
    id: 'deepseek-chat',
    label: 'DeepSeek Chat (legacy)',
    description:
      'Legacy alias for deepseek-v4-flash non-thinking mode. ' +
      'Deprecated 2026-07-24 — migrate to deepseek-v4-flash.',
    contextTokens: 1_000_000,
    capabilities: ['function_calling'],
    inputPricePer1M: 0.14,
    outputPricePer1M: 0.28,
  },
  {
    id: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner (legacy)',
    description:
      'Legacy alias for deepseek-v4-flash thinking mode. ' +
      'Deprecated 2026-07-24 — migrate to deepseek-v4-pro for ' +
      'reasoning workloads.',
    contextTokens: 1_000_000,
    capabilities: ['reasoning', 'function_calling'],
    inputPricePer1M: 0.14,
    outputPricePer1M: 0.28,
  },
];
