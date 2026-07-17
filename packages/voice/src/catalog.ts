/**
 * Catalog of TTS / STT models + voices, per provider.
 *
 * Why a static catalog at all: OpenAI does NOT expose a programmatic
 * endpoint to list voices. `/v1/audio/voices` doesn't exist; the voice
 * list is documentation-only and changes when OpenAI ships new models.
 * We keep the mapping in code so the UI can render a smart dropdown
 * (model selected → voices for that model appear) without each page
 * load having to scrape docs.
 *
 * What IS queryable: `/v1/models` returns the model ids the key has
 * access to (alongside chat/embedding models). We cross-reference our
 * catalog with that list to show ONLY the models the user can
 * actually use — accounts on the free tier, or older keys, don't
 * always have every model available.
 *
 * Maintenance: when OpenAI releases a new TTS model, add it here. The
 * UI doesn't need a code change as long as the catalog is current.
 *
 * Other providers (ElevenLabs, Deepgram) get their own catalog entries
 * when we implement them. ElevenLabs unlike OpenAI HAS a /v1/voices
 * endpoint that returns the full list (including user-cloned voices),
 * so for that provider we'd skip the static catalog and query live.
 */

import type { TtsVoice } from './types';

/** Every voice OpenAI has ever shipped (across all TTS models). Kept
 *  as the source-of-truth string union so other modules don't have to
 *  reconcile names. */
export const ALL_OPENAI_VOICES = [
  // Original 6 (tts-1, tts-1-hd).
  'alloy',
  'echo',
  'fable',
  'nova',
  'onyx',
  'shimmer',
  // Added with later expansions — usable by tts-1, tts-1-hd, gpt-4o-mini-tts.
  'ash',
  'coral',
  'sage',
  // Newer voices — only on gpt-4o-mini-tts.
  'ballad',
  'verse',
  // "Best quality" voices — gpt-4o-mini-tts only.
  'marin',
  'cedar',
] as const;

export type OpenAiVoice = (typeof ALL_OPENAI_VOICES)[number];

/** Short, human-readable description per voice. Used in the UI
 *  dropdown so the operator doesn't have to test all 13 to find the
 *  warm female voice. Pulled from OpenAI's published descriptions. */
export const VOICE_DESCRIPTIONS: Record<OpenAiVoice, string> = {
  alloy: 'neutral, balanced',
  ash: 'warm, expressive',
  ballad: 'reflective, narrative',
  cedar: 'high-quality, natural (recommended)',
  coral: 'warm, friendly female',
  echo: 'male, calm',
  fable: 'British, warm',
  marin: 'high-quality, natural (recommended)',
  nova: 'warm, female (Saskia default)',
  onyx: 'deep male, grounded',
  sage: 'measured, thoughtful',
  shimmer: 'soft, female',
  verse: 'expressive, emotive',
};

/** A model entry: what it is, which voices it supports, and which
 *  feature flags are on. */
export type TtsModelInfo = {
  id: string;
  label: string;
  description: string;
  /** Voice ids the model accepts. OpenAI ships a narrow named union
   *  (alloy/nova/shimmer/…); xAI ships their own (eve/ara/rex/sal/leo);
   *  Gemini ships 30 (Kore/Puck/Zephyr/…); ElevenLabs ships UUIDs and
   *  per-account clones. We type this as `readonly string[]` so each
   *  provider's adapter can return its own list without union-widening
   *  the framework. Consumers treating these as `OpenAiVoice` for
   *  type-narrowing have always known to runtime-check anyway. */
  voices: readonly string[];
  /** Whether the model accepts a free-form `instructions` parameter for
   *  style steering ("speak warmly", "be calm"). Only true for
   *  gpt-4o-mini-tts at the moment. */
  supportsInstructions: boolean;
  /** Tier hint for cost display. */
  tier: 'low-latency' | 'high-quality' | 'steerable';
};

/** TTS catalog. Order matters — list shown to users in this order in
 *  the dropdown. */
export const OPENAI_TTS_MODELS: readonly TtsModelInfo[] = [
  {
    id: 'gpt-4o-mini-tts',
    label: 'gpt-4o-mini-tts',
    description:
      'Newest TTS model. 13 voices, accepts style instructions ("speak warmly"). Recommended.',
    voices: [
      'alloy',
      'ash',
      'ballad',
      'coral',
      'echo',
      'fable',
      'nova',
      'onyx',
      'sage',
      'shimmer',
      'verse',
      'marin',
      'cedar',
    ],
    supportsInstructions: true,
    tier: 'steerable',
  },
  {
    id: 'tts-1',
    label: 'tts-1',
    description: 'Original TTS model. 9 voices, low latency. Cheaper than gpt-4o-mini-tts.',
    voices: ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
    supportsInstructions: false,
    tier: 'low-latency',
  },
  {
    id: 'tts-1-hd',
    label: 'tts-1-hd',
    description: 'Higher-quality variant of tts-1. Same 9 voices, higher fidelity, ~2× cost.',
    voices: ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
    supportsInstructions: false,
    tier: 'high-quality',
  },
] as const;

export type SttModelInfo = {
  id: string;
  label: string;
  description: string;
  /** Whether this model accepts the `language` hint param. */
  supportsLanguageHint: boolean;
  /** Whether this model returns word-level timestamps. */
  supportsTimestamps: boolean;
};

/** STT catalog. As of May 2026 OpenAI ships whisper-1 alongside the
 *  newer gpt-4o-mini-transcribe / gpt-4o-transcribe variants which
 *  are higher-quality but cost more. */
export const OPENAI_STT_MODELS: readonly SttModelInfo[] = [
  {
    id: 'whisper-1',
    label: 'whisper-1',
    description: 'Stable, cheap. Excellent multilingual support including Afrikaans.',
    supportsLanguageHint: true,
    supportsTimestamps: true,
  },
  {
    id: 'gpt-4o-mini-transcribe',
    label: 'gpt-4o-mini-transcribe',
    description: 'Newer transcription model. Better accuracy than whisper-1, similar price.',
    supportsLanguageHint: true,
    supportsTimestamps: false,
  },
  {
    id: 'gpt-4o-transcribe',
    label: 'gpt-4o-transcribe',
    description: 'Highest-accuracy transcription. Costs more; best for difficult audio.',
    supportsLanguageHint: true,
    supportsTimestamps: false,
  },
] as const;

/** Look up a TTS model by id. Returns null if we don't know about it
 *  (e.g. user typed a custom model name in the form). Callers should
 *  fall back to a permissive default voice list in that case. */
export function getTtsModel(id: string): TtsModelInfo | null {
  return OPENAI_TTS_MODELS.find((m) => m.id === id) ?? null;
}

export function getSttModel(id: string): SttModelInfo | null {
  return OPENAI_STT_MODELS.find((m) => m.id === id) ?? null;
}

/** Type-narrowing helper: is this voice valid for OpenAI? Used by the
 *  form validator and the synth call. */
export function isOpenAiVoice(v: string): v is OpenAiVoice {
  return (ALL_OPENAI_VOICES as readonly string[]).includes(v);
}

/** All voices, with descriptions, for a given model. Returned in a
 *  stable order matching the catalog. If the model isn't in the
 *  catalog, returns an empty array (caller decides whether to fall
 *  back to the legacy 6-voice list from @mantle/voice/types). */
export function voicesForModel(modelId: string): Array<{ id: OpenAiVoice; description: string }> {
  const model = getTtsModel(modelId);
  if (!model) return [];
  // OPENAI_TTS_MODELS only lists OpenAI voice ids by construction —
  // the runtime cast is safe because we narrow via getTtsModel which
  // only returns OpenAI catalog entries.
  return model.voices.map((v) => ({
    id: v as OpenAiVoice,
    description: VOICE_DESCRIPTIONS[v as OpenAiVoice] ?? '',
  }));
}

// Bridge to the existing TtsVoice union in types.ts — keeps backward
// compat with code already using that narrower type. New code should
// prefer OpenAiVoice for forward-compat with the expanded voice set.
void ([] as TtsVoice[]);
