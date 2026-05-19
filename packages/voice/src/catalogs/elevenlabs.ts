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

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';

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
};

export const ELEVENLABS_TTS_MODELS: readonly ElevenLabsTtsModel[] = [
  {
    id: 'eleven_v3',
    label: 'Eleven v3',
    description:
      'Newest, highest-quality generation. Best emotional range and pronunciation.',
    multilingual: true,
    speed: 'quality',
  },
  {
    id: 'eleven_multilingual_v2',
    label: 'Multilingual v2',
    description: 'Stable default. 29 languages, balanced quality + speed.',
    multilingual: true,
    speed: 'balanced',
  },
  {
    id: 'eleven_turbo_v2_5',
    label: 'Turbo v2.5',
    description: 'Lower latency, 32 languages. Use when speed matters more than perfection.',
    multilingual: true,
    speed: 'fast',
  },
  {
    id: 'eleven_flash_v2_5',
    label: 'Flash v2.5',
    description: 'Lowest latency (~75ms). 32 languages. Best for streaming.',
    multilingual: true,
    speed: 'fast',
  },
  {
    id: 'eleven_monolingual_v1',
    label: 'Monolingual v1',
    description: 'English-only legacy model. Cheap; consider v3 instead.',
    multilingual: false,
    speed: 'balanced',
  },
];

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
