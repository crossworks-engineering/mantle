/**
 * Anthropic (Claude) static catalog.
 *
 * Anthropic's API is NOT OpenAI-compatible. It uses its own message
 * format (system is a separate top-level field, messages contain only
 * user/assistant roles) at `https://api.anthropic.com/v1/messages`.
 * The adapter handles translation to/from the unified ChatDispatcher
 * interface so callers don't have to care.
 *
 * Auth: `x-api-key` header + a required `anthropic-version` header
 * (we pin to 2023-06-01 since that's the stable API). The Models API
 * at GET /v1/messages/../v1/models returns the live model list with
 * capabilities — we use it for discovery but the catalog below is
 * the source of truth for rich UI metadata.
 *
 * Maintenance: when Anthropic ships a new Claude generation (e.g.
 * 4.8 or 5.0), add it here. Anthropic uses dateless aliases for
 * 4.6+ (no more 'claude-3-5-sonnet-20241022' style), so model ids
 * stay readable.
 */

import type { ChatModelInfo } from '../adapters/types';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** Required header value on all Anthropic API calls. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

export const ANTHROPIC_CHAT_MODELS: readonly ChatModelInfo[] = [
  // ── Current generation (4.6/4.7) ─────────────────────────────────
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    description:
      'Anthropic flagship. Best for complex reasoning + agentic coding. 1M context.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'reasoning', 'function_calling'],
    inputPricePer1M: 5,
    outputPricePer1M: 25,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    description:
      'Best speed/intelligence balance. 1M context, supports extended thinking. Default choice.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'reasoning', 'function_calling'],
    inputPricePer1M: 3,
    outputPricePer1M: 15,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    description:
      'Fastest model with near-frontier intelligence. 200k context. Great for cheap, fast jobs.',
    contextTokens: 200_000,
    capabilities: ['vision', 'reasoning', 'function_calling'],
    inputPricePer1M: 1,
    outputPricePer1M: 5,
  },

  // ── Legacy (still available, slightly cheaper or different trade-offs) ──
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6 (legacy)',
    description: 'Previous Opus generation. Migrate to 4.7 for best results.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'reasoning', 'function_calling'],
    inputPricePer1M: 5,
    outputPricePer1M: 25,
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5 (legacy)',
    description: 'Previous Sonnet generation. Still capable; 200k context.',
    contextTokens: 200_000,
    capabilities: ['vision', 'reasoning', 'function_calling'],
    inputPricePer1M: 3,
    outputPricePer1M: 15,
  },
];
