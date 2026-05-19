export {
  transcribeAudio,
  filenameForMime,
} from './transcribe';

export {
  synthesizeSpeech,
  mimeForFormat,
  isTtsVoice,
} from './synthesize';

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

export {
  discoverTtsModels,
  discoverSttModels,
  type DiscoveryResult,
} from './discover';

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
export {
  composeAudioTagInstructions,
  stripAudioTags,
} from './audio-tags';
export type { AudioTag } from './adapters/types';

// ElevenLabs audio-tag catalog — exported so the UI can render the
// hint list under the voice dropdown when the worker is on v3.
export {
  ELEVENLABS_V3_AUDIO_TAGS,
  audioTagsForElevenLabsModel,
} from './catalogs/elevenlabs';
