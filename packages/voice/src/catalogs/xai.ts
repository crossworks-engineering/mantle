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

// ─── xAI TTS (Grok voice) ────────────────────────────────────────────
//
// Endpoint: POST {XAI_BASE_URL}/tts
// Auth:     Authorization: Bearer $XAI_API_KEY
// Body:     {text, voice_id, language, output_format: {codec, sample_rate, bit_rate}}
//
// 5 voices, 20+ languages auto-detected, inline + wrapping speech tags.

import type { AudioTag } from '../adapters/types';

/** Grok TTS model — xAI publishes "grok-voice-latest" as the alias. */
export const XAI_TTS_MODEL_ID = 'grok-voice-latest';

/** Voice catalog for Grok TTS. 5 voices, gender/character hints from
 *  the xAI launch blog. Operators see these in the worker form. */
export const XAI_TTS_VOICES = [
  { id: 'eve', description: 'female, warm — Grok default' },
  { id: 'ara', description: 'female, clear and bright' },
  { id: 'rex', description: 'male, deep and grounded' },
  { id: 'sal', description: 'male, neutral and friendly' },
  { id: 'leo', description: 'male, animated and energetic' },
] as const;

/**
 * Inline speech tags Grok TTS honours. Square-bracket form, same shape
 * as ElevenLabs's `[laughs]`. Pulled from
 *   https://docs.x.ai/developers/rest-api-reference/inference/voice
 *
 * NOTE: xAI also supports a separate vocabulary of WRAPPING tags
 * (`<soft>…</soft>`, `<whisper>…</whisper>`, `<emphasis>…</emphasis>`,
 * `<slow>…</slow>`, `<sing-song>…</sing-song>` etc.) that wrap whole
 * phrases. Our AudioTag framework only handles the inline bracket
 * form today — wrapping tags are a future expansion when (if) other
 * providers adopt them.
 */
export const XAI_AUDIO_TAGS: readonly AudioTag[] = [
  // Reactions / human sounds.
  { tag: '[laugh]', description: 'a hearty laugh', category: 'reaction' },
  { tag: '[chuckle]', description: 'a short, dry amusement', category: 'reaction' },
  { tag: '[giggle]', description: 'a light, playful laugh', category: 'reaction' },
  { tag: '[sigh]', description: 'a resigned or reflective exhale', category: 'reaction' },
  { tag: '[cry]', description: 'a sob or weeping; use rarely', category: 'reaction' },
  { tag: '[tsk]', description: 'a disapproving cluck', category: 'reaction' },
  { tag: '[tongue-click]', description: 'a sharp tongue cluck — punctuation', category: 'reaction' },
  { tag: '[lip-smack]', description: 'a soft mouth sound; thoughtful beat', category: 'reaction' },
  { tag: '[hum-tune]', description: 'a short hummed melody', category: 'reaction' },

  // Breath.
  { tag: '[breath]', description: 'a soft audible breath', category: 'reaction' },
  { tag: '[inhale]', description: 'a sharp inhale; surprise or anticipation', category: 'reaction' },
  { tag: '[exhale]', description: 'a deliberate exhale; release', category: 'reaction' },

  // Pacing.
  { tag: '[pause]', description: 'a short pause', category: 'cognitive' },
  { tag: '[long-pause]', description: 'a longer pause for emphasis', category: 'cognitive' },
];

/**
 * Returns the tag set for a given Grok TTS model. xAI publishes one
 * voice model today (grok-voice-latest); future variants would branch
 * here.
 */
export function audioTagsForXaiTtsModel(modelId: string): readonly AudioTag[] {
  if (modelId === XAI_TTS_MODEL_ID || modelId === 'grok-voice') {
    return XAI_AUDIO_TAGS;
  }
  return [];
}
