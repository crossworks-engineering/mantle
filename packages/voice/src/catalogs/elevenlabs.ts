/**
 * ElevenLabs static catalog.
 *
 * ElevenLabs's TTS API is shaped very differently from OpenAI:
 *   - Voice id lives in the URL: POST /v1/text-to-speech/{voice_id}
 *   - Model id is in the request body (`model_id`)
 *   - Output format is a QUERY param (`output_format=opus_48000_64`)
 *   - Voices include user-cloned ones (returned by /v1/voices)
 *
 * Models below are the publicly-documented voice synthesis models.
 * Discovery via GET /v1/models returns the live list including any
 * preview/beta models the key has access to.
 *
 * Voice strategy: ElevenLabs has hundreds of voices (premade + cloned).
 * The adapter's `voicesForModel` queries `/v1/voices` live to return
 * every voice the key can use — including the user's clones — rather
 * than hardcoding a list. The static fallback below is the small set
 * of "premade" voices everyone gets, used only when discovery fails.
 *
 * Output format mapping for Mantle's Telegram-voice use case:
 *   `opus_48000_64` → 'audio/ogg', plays as a Telegram voice-note bubble.
 *   Other formats are available for non-Telegram surfaces.
 */

import type { AudioTag } from '../adapters/types';

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';

/**
 * Documented v3 audio tags. ElevenLabs publishes these in five
 * conceptual buckets (their docs use slightly different names; we
 * normalise to the categories on the AudioTag type). Saskia gets a
 * paragraph in her prompt listing the supported tags when the active
 * TTS worker is configured for ElevenLabs v3.
 *
 * Tags are case-insensitive in the API but we render them lowercase
 * for consistency. Pulled from
 *   https://elevenlabs.io/blog/v3-audiotags
 *   https://elevenlabs.io/blog/eleven-v3-audio-tags-expressing-emotional-context-in-speech
 *
 * Not exhaustive — ElevenLabs's docs say "many more effective tags
 * beyond the listed examples." This list covers the ones with
 * documented, stable behaviour.
 */
export const ELEVENLABS_V3_AUDIO_TAGS: readonly AudioTag[] = [
  // Human reactions — the most useful for conversational warmth.
  { tag: '[laughs]', description: 'a warm chuckle; use for genuine amusement', category: 'reaction' },
  { tag: '[laughs softly]', description: 'a quiet, intimate chuckle', category: 'reaction' },
  { tag: '[chuckles]', description: 'short, dry amusement', category: 'reaction' },
  { tag: '[snorts]', description: 'a short, derisive or surprised exhale', category: 'reaction' },
  { tag: '[sighs]', description: 'resigned exhale; reflective or weary', category: 'reaction' },
  { tag: '[gasps]', description: 'sharp inhale of surprise', category: 'reaction' },
  { tag: '[clears throat]', description: 'transitional beat, often before a serious point', category: 'reaction' },

  // Delivery / performance.
  { tag: '[whispers]', description: 'intimate, lowered voice for secrets or asides', category: 'delivery' },
  { tag: '[shouts]', description: 'raised voice; use sparingly', category: 'delivery' },

  // Cognitive / pacing beats.
  { tag: '[pauses]', description: 'a deliberate beat of silence', category: 'cognitive' },
  { tag: '[hesitates]', description: 'briefly stalls, as if thinking', category: 'cognitive' },
  { tag: '[stammers]', description: 'broken cadence; nerves or surprise', category: 'cognitive' },

  // Emotional states (modify the line that follows).
  { tag: '[excited]', description: 'warm, energetic delivery', category: 'emotion' },
  { tag: '[curious]', description: 'rising-inflection, inquisitive', category: 'emotion' },
  { tag: '[happy]', description: 'bright, smiling tone', category: 'emotion' },
  { tag: '[sad]', description: 'slower, weighted', category: 'emotion' },
  { tag: '[nervous]', description: 'slightly faster, breathier', category: 'emotion' },
  { tag: '[frustrated]', description: 'tight, clipped', category: 'emotion' },
  { tag: '[calm]', description: 'steady, unhurried', category: 'emotion' },
  { tag: '[sorrowful]', description: 'deeper sadness; for genuine grief', category: 'emotion' },
  { tag: '[mischievously]', description: 'playful, with a hint of trouble', category: 'emotion' },
  { tag: '[crying]', description: 'distressed delivery; rare', category: 'emotion' },

  // Tone cues.
  { tag: '[cheerfully]', description: 'lift and brightness throughout', category: 'tone' },
  { tag: '[flatly]', description: 'unaffected, monotone', category: 'tone' },
  { tag: '[deadpan]', description: 'expressionless; great for dry humour', category: 'tone' },
  { tag: '[playfully]', description: 'light, teasing', category: 'tone' },
  { tag: '[resigned tone]', description: 'accepting the inevitable; soft sigh implicit', category: 'tone' },
];

/** TTS model metadata. ElevenLabs swaps the OpenAI {model,voice}
 *  separation so each entry represents the TTS engine, not the voice. */
export type ElevenLabsTtsModel = {
  id: string;
  label: string;
  description: string;
  /** True if the model supports >29 languages. */
  multilingual: boolean;
  /** Approximate output speed tier ('fast' / 'balanced' / 'quality'). */
  speed: 'fast' | 'balanced' | 'quality';
  /** Whether this model honours inline audio tags. Only v3 has the
   *  full vocabulary; older models render bracketed tags as literal
   *  text (which is why we strip them defensively before send). */
  supportsAudioTags?: boolean;
};

export const ELEVENLABS_TTS_MODELS: readonly ElevenLabsTtsModel[] = [
  {
    id: 'eleven_v3',
    label: 'Eleven v3',
    description:
      'Newest, highest-quality generation. Honours the full inline audio-tag vocabulary (laughs, whispers, sighs, emotion cues).',
    multilingual: true,
    speed: 'quality',
    supportsAudioTags: true,
  },
  {
    id: 'eleven_multilingual_v2',
    label: 'Multilingual v2',
    description:
      'Stable default. 29 languages, balanced quality + speed. Inline audio tags NOT honoured — they get rendered as literal text, so the adapter strips them.',
    multilingual: true,
    speed: 'balanced',
    supportsAudioTags: false,
  },
  {
    id: 'eleven_turbo_v2_5',
    label: 'Turbo v2.5',
    description:
      'Lower latency, 32 languages. Use when speed matters more than perfection. No inline audio tags.',
    multilingual: true,
    speed: 'fast',
    supportsAudioTags: false,
  },
  {
    id: 'eleven_flash_v2_5',
    label: 'Flash v2.5',
    description:
      'Lowest latency (~75ms). 32 languages. Best for streaming. No inline audio tags.',
    multilingual: true,
    speed: 'fast',
    supportsAudioTags: false,
  },
  {
    id: 'eleven_monolingual_v1',
    label: 'Monolingual v1',
    description: 'English-only legacy model. Cheap; consider v3 instead.',
    multilingual: false,
    speed: 'balanced',
    supportsAudioTags: false,
  },
];

/**
 * Audio-tag lookup per model. Returns the documented tag set for
 * models that support them, empty list otherwise. Used by the
 * ElevenLabs adapter's `supportedAudioTags` to gate which tags are
 * advertised to the LLM in Saskia's prompt.
 */
export function audioTagsForElevenLabsModel(modelId: string): readonly AudioTag[] {
  const m = ELEVENLABS_TTS_MODELS.find((x) => x.id === modelId);
  if (!m || !m.supportsAudioTags) return [];
  // Today only v3 has documented tags. When ElevenLabs publishes a
  // tag set for a future model, branch here on modelId rather than
  // returning the same list for every supporting model.
  return ELEVENLABS_V3_AUDIO_TAGS;
}

/** Output format query-param values. We pick `opus_48000_64` for
 *  Telegram (Telegram-native voice notes are OGG/Opus), but other
 *  surfaces may want different containers. */
export const ELEVENLABS_OUTPUT_FORMATS = [
  'opus_48000_64',
  'opus_48000_128',
  'mp3_44100_128',
  'mp3_44100_192',
  'mp3_22050_32',
  'pcm_16000',
  'pcm_44100',
  'wav_44100',
] as const;
export type ElevenLabsOutputFormat = (typeof ELEVENLABS_OUTPUT_FORMATS)[number];

/** MIME for a given ElevenLabs output_format. Used when handing the
 *  audio bytes off to Telegram or to the browser <audio> element. */
export function mimeForElevenLabsFormat(format: string): string {
  if (format.startsWith('opus_')) return 'audio/ogg';
  if (format.startsWith('mp3_')) return 'audio/mpeg';
  if (format.startsWith('wav_')) return 'audio/wav';
  if (format.startsWith('pcm_')) return 'audio/pcm';
  if (format.startsWith('ulaw_')) return 'audio/basic';
  if (format.startsWith('alaw_')) return 'audio/basic';
  return 'application/octet-stream';
}

/**
 * Default premade voice ids. Used as a static fallback when the
 * /v1/voices discovery call fails. These ids are stable across
 * accounts — ElevenLabs ships them with every free + paid plan.
 */
export const ELEVENLABS_PREMADE_VOICES: readonly { id: string; description: string }[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', description: 'Rachel — calm, narrative female' },
  { id: 'AZnzlk1XvdvUeBnXmlld', description: 'Domi — strong, confident female' },
  { id: 'EXAVITQu4vr4xnSDxMaL', description: 'Bella — soft, gentle female' },
  { id: 'ErXwobaYiN019PkySvjV', description: 'Antoni — warm male' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', description: 'Elli — emotional, expressive female' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', description: 'Josh — deep male' },
  { id: 'VR6AewLTigWG4xSOukaG', description: 'Arnold — crisp male' },
  { id: 'pNInz6obpgDQGcFmaJgB', description: 'Adam — narrative male' },
  { id: 'yoZ06aMxZJJ28mfd3POQ', description: 'Sam — neutral male' },
];
