export { transcribeAudio, filenameForMime } from './transcribe';

export { synthesizeSpeech, mimeForFormat, isTtsVoice } from './synthesize';

export type {
  TranscribeOptions,
  TranscribeResult,
  SynthesizeOptions,
  SynthesizeResult,
  TtsVoice,
} from './types';

export { TTS_VOICES } from './types';

export {
  ALL_OPENAI_VOICES,
  VOICE_DESCRIPTIONS,
  OPENAI_TTS_MODELS,
  OPENAI_STT_MODELS,
  getTtsModel,
  getSttModel,
  isOpenAiVoice,
  voicesForModel,
  type OpenAiVoice,
  type TtsModelInfo,
  type SttModelInfo,
} from './catalog';

export { discoverTtsModels, discoverSttModels, type DiscoveryResult } from './discover';

export {
  SUPPORTED_PROVIDERS,
  CAPABILITY_FOR_KIND,
  getProvider,
  providersForCapability,
  isProviderId,
  type Provider,
  type ProviderId,
  type ProviderCapability,
} from './providers';

// Adapter layer. Importing this module triggers self-registration of
// every built-in adapter (OpenAI TTS, OpenAI STT today). Apps go
// through `getTtsAdapter(providerId)` etc. instead of calling
// `synthesizeSpeech` directly so future providers (ElevenLabs,
// Deepgram, …) slot in via the registry with no caller changes.
export * from './adapters';

// Audio-tag composition + stripping helpers. Pure, importable from
// any layer — used by the runtime prompt builder (to tell Saskia
// which tags her TTS will honour) and by the text-out path (to
// strip tags from replies that end up routed as plain text).
export { composeAudioTagInstructions, stripAudioTags } from './audio-tags';
export type { AudioTag, WrappingTag } from './adapters/types';

// ElevenLabs audio-tag catalog — exported so the UI can render the
// hint list under the voice dropdown when the worker is on v3.
export { ELEVENLABS_V3_AUDIO_TAGS, audioTagsForElevenLabsModel } from './catalogs/elevenlabs';

/** Default describe-and-transcribe prompt for passive image ingest. Shared
 *  by the web /assistant upload, the Telegram photo branch, and the
 *  extractor's image-vision pass so OCR/description behaviour stays identical
 *  across surfaces. Question-aware variants (when the user asked something
 *  alongside the image) live at each call site. */
export const DEFAULT_VISION_DESCRIBE_PROMPT =
  "Describe what's in this image in one or two sentences — the main subject, objects, logos, people, or scene. Then, if the image contains any text, transcribe it verbatim below the description (preserve line breaks; mark anything unclear as [unclear]). If there's no text, the description alone is enough. Output plain text only.";
