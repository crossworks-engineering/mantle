/**
 * Google (Gemini) static catalog.
 *
 * Gemini's API is NOT OpenAI-compatible. It uses `contents` (with
 * `parts`) instead of `messages`, `systemInstruction` as a separate
 * top-level field, and roles 'user' / 'model' (not 'assistant'). The
 * adapter handles the translation.
 *
 * Endpoint: POST /v1beta/models/{model}:generateContent
 * Auth: `x-goog-api-key` header
 * Models endpoint: GET /v1beta/models?key=...
 *
 * Notable Gemini quirks:
 *   - Huge context windows (1M-2M tokens) for the 3.x models.
 *   - 3.x is preview-tagged but production-stable for most uses.
 *   - Gemini also ships TTS and embedding models — we cover chat here;
 *     a separate google-tts.ts / google-embed.ts can land later.
 */

import type { ChatModelInfo } from '../adapters/types';

export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export const GOOGLE_CHAT_MODELS: readonly ChatModelInfo[] = [
  // ── Gemini 3 series (current) ────────────────────────────────────
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro (preview)',
    description:
      'Latest flagship. Advanced reasoning, multimodal, 2M context. Recommended default.',
    contextTokens: 2_000_000,
    capabilities: ['vision', 'reasoning', 'function_calling', 'json_mode'],
  },
  {
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash (preview)',
    description: 'Frontier-class performance at low cost. Fast multimodal.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'function_calling', 'json_mode'],
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash Lite',
    description: 'Stable Flash-Lite tier. Cheapest in the 3.x family.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'function_calling'],
  },

  // ── Gemini 2.5 series (stable, widely available) ─────────────────
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    description: 'Stable Pro tier. 2M context, deep reasoning, multimodal.',
    contextTokens: 2_000_000,
    capabilities: ['vision', 'reasoning', 'function_calling', 'json_mode'],
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description: 'Best price/perf in the 2.5 family. Multimodal.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'function_calling', 'json_mode'],
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    description: 'Fastest and most budget-friendly multimodal model.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'function_calling'],
  },
];
