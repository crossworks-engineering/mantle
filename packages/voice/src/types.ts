/**
 * Shared types for voice in/out. Kept in a tiny module so the Whisper
 * and TTS modules don't have to cross-import each other for shared
 * shapes (and so consumers can import just the type without pulling
 * the runtime).
 */

/** Options accepted by `transcribeAudio`. */
export type TranscribeOptions = {
  /** OpenAI API key in plaintext. Resolved by the caller from
   *  api_keys — this module does not look up keys itself. */
  apiKey: string;
  /** MIME of the supplied buffer, e.g. 'audio/ogg' for Telegram voice
   *  notes. Whisper accepts mp3/mp4/mpeg/mpga/m4a/wav/webm/ogg/flac. */
  mimeType: string;
  /** Hard cap on the source duration in seconds. Set to refuse long
   *  clips before paying for transcription. Defaults to 180 (3 min).
   *  Pass 0 to disable. */
  maxDurationSeconds?: number;
  /** Optional ISO-639-1 language hint. Whisper auto-detects when
   *  omitted, which is what we usually want for a multilingual user. */
  language?: string;
  /** Override the Whisper model. Defaults to `whisper-1`, the only
   *  current production model. Pinned here so a future rename doesn't
   *  silently shift behaviour. */
  model?: string;
};

export type TranscribeResult = {
  /** Transcribed text — already trimmed. */
  text: string;
  /** Detected language (ISO-639-1 or longer code) if the API surfaced
   *  it. May be null on errors or older response formats. */
  language: string | null;
  /** Source duration in seconds (from the OpenAI response). */
  durationSeconds: number | null;
  /** Model that did the work, recorded for /traces. */
  model: string;
};

/** OpenAI TTS voice names. Kept as a typed enum so the agent settings
 *  UI can render a closed dropdown, and so a typo doesn't get sent to
 *  the API and silently default to alloy.
 *
 *  Set expanded May 2026: gpt-4o-mini-tts shipped 4 new voices
 *  (ballad, verse, marin, cedar) plus made ash/coral/sage usable across
 *  all models. The older tts-1 / tts-1-hd models accept a SUBSET of
 *  these — see `catalog.ts` for the per-model voice list. The union
 *  here is the full set so calling code stays correct regardless of
 *  which model the worker is configured with; the catalog filters at
 *  display time. */
export const TTS_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'cedar',
  'coral',
  'echo',
  'fable',
  'marin',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];

export type SynthesizeOptions = {
  /** OpenAI API key in plaintext. */
  apiKey: string;
  /** Text to speak. Hard-limited by the caller (or trimmed here) to
   *  keep cost bounded. */
  text: string;
  /** Voice name; defaults to 'nova'. */
  voice?: TtsVoice;
  /** Model. Free-text so newer models (gpt-4o-mini-tts) work without
   *  a code change. `tts-1` / `tts-1-hd` / `gpt-4o-mini-tts` are the
   *  currently published options — see `catalog.ts`. */
  model?: string;
  /** Playback speed multiplier 0.25–4.0. Defaults to 1.0. */
  speed?: number;
  /** Output container. Defaults to 'opus' which is what Telegram
   *  voice notes use natively — sending opus avoids a transcode step
   *  and gets the bubble-style voice-note UI in chat. */
  format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  /** Style-steering instructions ("speak warmly", "calm and slow").
   *  Only honoured by `gpt-4o-mini-tts`; older models ignore the
   *  field. We pass it through unconditionally because the OpenAI
   *  endpoint doesn't error on extra params. */
  instructions?: string;
  /** Optional BCP-47 language hint (e.g. 'en', 'fr', 'pt-BR') or
   *  'auto' to let the provider detect. Different providers do
   *  different things with this:
   *    - xAI:        forces the voice to speak in this language (so a
   *                  voice cloned with French audio + language='fr'
   *                  gets a French accent regardless of input text).
   *    - Google:     used to bias TTS pronunciation.
   *    - ElevenLabs: ignored — voice + model carry the language.
   *    - OpenAI:     ignored — TTS infers from text.
   *  Defaults to provider-specific auto when omitted. */
  language?: string;
};

/** A synthesis option that may or may not survive the trip to a provider.
 *  `voice` and `model` are excluded on purpose: every TTS API has both, and a
 *  request without them is meaningless rather than degraded. */
export type TtsParam = 'speed' | 'format' | 'instructions' | 'language';

/** One option the adapter chose not to send, and why. Same convention as
 *  `ImageGenWarning` on the image side, for the same reason: the alternative
 *  is an operator setting something in /settings/ai-workers, seeing it saved,
 *  and never learning it does nothing. Providers differ enormously here —
 *  Gemini TTS has no speed parameter at all, ElevenLabs takes a language code
 *  on some models and rejects the idea on others — so the honest answer is
 *  per-adapter and sometimes per-model. */
export type TtsWarning = {
  param: TtsParam;
  reason: string;
};

export type SynthesizeResult = {
  /** Audio bytes in the requested format. */
  bytes: Buffer;
  /** MIME of the returned audio — e.g. 'audio/ogg' for opus. */
  mimeType: string;
  /** Voice + model used. Echoed back so /traces can record it. */
  voice: TtsVoice;
  model: string;
  /** Options this MODEL had no use for. Absent ⇒ everything applied.
   *  Per-model, so it complements the per-provider `TtsDispatcher.supports`. */
  warnings?: readonly TtsWarning[];
};
