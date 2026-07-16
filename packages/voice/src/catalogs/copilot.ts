/**
 * GitHub Copilot static catalog.
 *
 * Copilot exposes an OpenAI-compatible `/chat/completions` endpoint at
 * `api.githubcopilot.com` that fronts a rotating roster of frontier models
 * (GPT, Claude, Gemini, o-series) under one subscription. The adapter at
 * `../adapters/copilot-chat.ts` reuses the shared openai-compat helpers and
 * adds Copilot's token exchange + editor headers (see `copilot-auth.ts`).
 *
 * Auth: the worker's "API key" is a GitHub OAuth token (the Copilot device-flow
 * token, `gho_…`); the adapter exchanges it for a short-lived Copilot token.
 *
 * The roster changes often and is gated by the account's Copilot plan, so live
 * discovery (`GET /models`) is authoritative — this list is just what the model
 * dropdown shows before discovery returns. Reasoning models carry the
 * 'reasoning' capability; the adapter requests reasoning via `reasoning_effort`
 * when the thinking budget is set. Prices are omitted (Copilot bills by
 * subscription / request quota, not per-token).
 */

import type { ChatModelInfo } from '../adapters/types';

export const COPILOT_BASE_URL = 'https://api.githubcopilot.com';

export const COPILOT_CHAT_MODELS: readonly ChatModelInfo[] = [
  {
    id: 'gpt-5',
    label: 'GPT-5 (Copilot)',
    description:
      'OpenAI GPT-5 via GitHub Copilot. Reasoning model — depth set by reasoning_effort.',
    contextTokens: 264_000,
    capabilities: ['reasoning', 'function_calling', 'vision'],
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 mini (Copilot)',
    description: 'Faster, cheaper GPT-5 tier via Copilot. Reasoning-capable.',
    contextTokens: 264_000,
    capabilities: ['reasoning', 'function_calling'],
  },
  {
    id: 'claude-sonnet-4.5',
    label: 'Claude Sonnet 4.5 (Copilot)',
    description:
      'Anthropic Claude Sonnet 4.5 via Copilot. Strong agentic + tool use, reasoning-capable.',
    contextTokens: 200_000,
    capabilities: ['reasoning', 'function_calling', 'vision'],
  },
  {
    id: 'o4-mini',
    label: 'o4-mini (Copilot)',
    description: 'OpenAI o4-mini reasoning model via Copilot. Fast reasoning for tool-heavy work.',
    contextTokens: 200_000,
    capabilities: ['reasoning', 'function_calling'],
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro (Copilot)',
    description: 'Google Gemini 2.5 Pro via Copilot. Large context, reasoning-capable.',
    contextTokens: 1_000_000,
    capabilities: ['reasoning', 'function_calling', 'vision'],
  },
];
