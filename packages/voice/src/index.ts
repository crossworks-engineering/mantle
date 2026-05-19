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
