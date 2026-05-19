/**
 * xAI (Grok) static catalog.
 *
 * The xAI docs don't officially publish a /v1/models programmatic
 * listing — operators have to consult the console. We mirror what's
 * documented at https://docs.x.ai/developers/models so the dropdown
 * has rich descriptions and capability flags. The adapter still
 * attempts a live `GET /v1/models` call (the API is OpenAI-compatible
 * so it almost always implements it), and if that succeeds we
 * intersect with this catalog to narrow to "what this key can use."
 *
 * Maintenance: when xAI ships a new Grok variant, add an entry here.
 * Anything missing falls through to plain text-input ("Custom model
 * id — make sure your key has access") rather than blocking the user.
 *
 * Pricing reference (May 2026 docs): grok-4.3 = $1.25/$2.50 per 1M
 * input/output tokens, 1M context window. Older grok-3 variants
 * redirect to grok-4.3 since May 15.
 */

import type { ChatModelInfo } from '../adapters/types';

export const XAI_CHAT_MODELS: readonly ChatModelInfo[] = [
  {
    id: 'grok-4.3',
    label: 'Grok 4.3',
    description:
      'Current default. Most intelligent and fastest. Aliased from any deprecated grok-3/4 model id.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'function_calling', 'json_mode'],
    inputPricePer1M: 1.25,
    outputPricePer1M: 2.5,
  },
  {
    id: 'grok-4.20-0309-reasoning',
    label: 'Grok 4.20 (reasoning)',
    description:
      'Reasoning variant. Configure effort with reasoning_effort: low | medium | high.',
    contextTokens: 1_000_000,
    capabilities: ['reasoning', 'function_calling', 'json_mode'],
    inputPricePer1M: 1.25,
    outputPricePer1M: 2.5,
  },
  {
    id: 'grok-4.20-0309-non-reasoning',
    label: 'Grok 4.20 (no reasoning)',
    description: 'Faster, cheaper variant of 4.20 without reasoning tokens.',
    contextTokens: 1_000_000,
    capabilities: ['function_calling', 'json_mode'],
    inputPricePer1M: 1.25,
    outputPricePer1M: 2.5,
  },
  {
    id: 'grok-4.20-multi-agent-0309',
    label: 'Grok 4.20 (multi-agent)',
    description: '2M context, designed for multi-agent workflows with shared state.',
    contextTokens: 2_000_000,
    capabilities: ['function_calling', 'json_mode'],
    inputPricePer1M: 1.25,
    outputPricePer1M: 2.5,
  },
  {
    id: 'grok-3',
    label: 'Grok 3 (alias)',
    description:
      'Alias — requests redirect to grok-4.3 and bill at grok-4.3 rates as of May 15, 2026.',
    contextTokens: 1_000_000,
    capabilities: ['vision', 'function_calling'],
    inputPricePer1M: 1.25,
    outputPricePer1M: 2.5,
  },
];

export const XAI_BASE_URL = 'https://api.x.ai/v1';
