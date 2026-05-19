/**
 * Adapter barrel + self-registration.
 *
 * Importing this module is enough to wire up every built-in adapter.
 * The package's `index.ts` re-exports from here, so the first call
 * site that pulls anything from `@mantle/voice` ends up touching this
 * file and registering the OpenAI adapters.
 *
 * Adding a new built-in adapter:
 *   1. Create `./openai-something.ts` (or `./elevenlabs-tts.ts`).
 *   2. `import { foo } from './elevenlabs-tts';`
 *   3. `registerTtsAdapter(foo);` (or whichever capability).
 *   4. The UI picks it up automatically because the registry drives
 *      the `isProviderWired` flag in the providers catalog.
 */

import {
  findAdapterCatalogDrift,
  registerChatAdapter,
  registerImageGenAdapter,
  registerSttAdapter,
  registerTtsAdapter,
  registerVisionAdapter,
} from './registry';
import { SUPPORTED_PROVIDERS } from '../providers';
import { openAiTtsAdapter } from './openai-tts';
import { openAiSttAdapter } from './openai-stt';
import { xaiChatAdapter } from './xai-chat';
import { huggingfaceChatAdapter } from './huggingface-chat';
import { anthropicChatAdapter } from './anthropic-chat';
import { googleChatAdapter } from './google-chat';
import { googleTtsAdapter } from './google-tts';
import { googleSttAdapter } from './google-stt';
import { xaiTtsAdapter } from './xai-tts';
import { xaiSttAdapter } from './xai-stt';
import { elevenLabsTtsAdapter } from './elevenlabs-tts';
import { elevenLabsSttAdapter } from './elevenlabs-stt';
import { deepgramSttAdapter } from './deepgram-stt';
import { assemblyAiSttAdapter } from './assemblyai-stt';
import { openAiVisionAdapter } from './openai-vision';
import { anthropicVisionAdapter } from './anthropic-vision';
import { googleVisionAdapter } from './google-vision';
import { xaiVisionAdapter } from './xai-vision';
import { openAiImageAdapter } from './openai-image';
import { xaiImageAdapter } from './xai-image';
import { googleImageAdapter } from './google-image';
import { huggingfaceImageAdapter } from './huggingface-image';

// Built-in adapters. Order doesn't matter — these are just into a
// Map keyed by providerId.
registerTtsAdapter(openAiTtsAdapter);
registerTtsAdapter(elevenLabsTtsAdapter);
registerTtsAdapter(xaiTtsAdapter);
registerTtsAdapter(googleTtsAdapter);
registerSttAdapter(openAiSttAdapter);
registerSttAdapter(xaiSttAdapter);
registerSttAdapter(elevenLabsSttAdapter);
registerSttAdapter(deepgramSttAdapter);
registerSttAdapter(assemblyAiSttAdapter);
registerSttAdapter(googleSttAdapter);
registerChatAdapter(xaiChatAdapter);
registerChatAdapter(huggingfaceChatAdapter);
registerChatAdapter(anthropicChatAdapter);
registerChatAdapter(googleChatAdapter);
registerVisionAdapter(openAiVisionAdapter);
registerVisionAdapter(anthropicVisionAdapter);
registerVisionAdapter(googleVisionAdapter);
registerVisionAdapter(xaiVisionAdapter);
registerImageGenAdapter(openAiImageAdapter);
registerImageGenAdapter(xaiImageAdapter);
registerImageGenAdapter(googleImageAdapter);
registerImageGenAdapter(huggingfaceImageAdapter);

// Surface drift between registered adapters and the providers catalog
// at module-load time. The catalog drives UI dropdown filters via
// providersForCapability; a registered adapter whose catalog entry
// doesn't declare the capability would invisibly disappear from the
// worker form (precisely the bug that hit when xai-tts + google-tts
// shipped — adapters registered, catalog still chat-only). The
// catalog-consistency.test.ts asserts the same thing at CI time.
// Warn rather than throw: a single typo shouldn't take down the
// agent process in production.
{
  const drift = findAdapterCatalogDrift(SUPPORTED_PROVIDERS);
  if (drift.length > 0) {
    for (const msg of drift) {
      console.warn(`[mantle/voice] adapter↔catalog drift: ${msg}`);
    }
  }
}

export {
  findAdapterCatalogDrift,
  registerChatAdapter,
  getChatAdapter,
  listChatAdapters,
  registerTtsAdapter,
  getTtsAdapter,
  listTtsAdapters,
  registerSttAdapter,
  getSttAdapter,
  listSttAdapters,
  registerVisionAdapter,
  getVisionAdapter,
  registerImageGenAdapter,
  getImageGenAdapter,
  isProviderWired,
} from './registry';

export {
  type ChatDispatcher,
  type ChatModelInfo,
  type ChatOptions,
  type ChatResult,
  type TtsDispatcher,
  type SttDispatcher,
  type VisionDispatcher,
  type VisionExtractOptions,
  type VisionExtractResult,
  type VisionModelInfo,
  type ImageGenDispatcher,
  type ImageGenModelInfo,
  type GenerateImageOptions,
  type GenerateImageResult,
  type AdapterMeta,
} from './types';

// Re-export the built-in adapter objects so apps can compose them
// (e.g. for testing against a mocked HTTP layer).
export { openAiTtsAdapter } from './openai-tts';
export { openAiSttAdapter } from './openai-stt';
export { xaiSttAdapter } from './xai-stt';
export { elevenLabsSttAdapter } from './elevenlabs-stt';
export { deepgramSttAdapter } from './deepgram-stt';
export { assemblyAiSttAdapter } from './assemblyai-stt';
export { googleSttAdapter } from './google-stt';
export { openAiVisionAdapter } from './openai-vision';
export { anthropicVisionAdapter } from './anthropic-vision';
export { googleVisionAdapter } from './google-vision';
export { xaiVisionAdapter } from './xai-vision';
export { openAiImageAdapter } from './openai-image';
export { xaiImageAdapter } from './xai-image';
export { googleImageAdapter } from './google-image';
export { huggingfaceImageAdapter } from './huggingface-image';
export { xaiChatAdapter } from './xai-chat';
export {
  huggingfaceChatAdapter,
  HUGGINGFACE_ROUTING_POLICIES,
  type HuggingfaceRoutingPolicy,
} from './huggingface-chat';
export { anthropicChatAdapter } from './anthropic-chat';
export { googleChatAdapter } from './google-chat';
export { googleTtsAdapter } from './google-tts';
export { xaiTtsAdapter } from './xai-tts';
export { elevenLabsTtsAdapter } from './elevenlabs-tts';

// Catalogues — exposed so the UI can render the static list before
// live discovery completes.
export {
  XAI_CHAT_MODELS,
  XAI_BASE_URL,
  XAI_TTS_MODEL_ID,
  XAI_TTS_VOICES,
  XAI_AUDIO_TAGS,
  XAI_STT_MODELS,
  XAI_VISION_MODELS,
  XAI_IMAGE_MODELS,
  XAI_IMAGE_DEFAULT_MODEL,
  audioTagsForXaiTtsModel,
} from '../catalogs/xai';
export {
  HUGGINGFACE_CHAT_MODELS,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_INFERENCE_BASE_URL,
  HUGGINGFACE_IMAGE_MODELS,
  HUGGINGFACE_IMAGE_DEFAULT_MODEL,
} from '../catalogs/huggingface';
export {
  ANTHROPIC_CHAT_MODELS,
  ANTHROPIC_VISION_MODELS,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_API_VERSION,
} from '../catalogs/anthropic';
export {
  GOOGLE_CHAT_MODELS,
  GOOGLE_BASE_URL,
  GOOGLE_TTS_MODELS,
  GOOGLE_TTS_VOICES,
  GOOGLE_AUDIO_TAGS,
  GOOGLE_STT_MODELS,
  GOOGLE_VISION_MODELS,
  GOOGLE_IMAGE_MODELS,
  GOOGLE_IMAGE_DEFAULT_MODEL,
  audioTagsForGoogleTtsModel,
  type GoogleTtsModelId,
} from '../catalogs/google';
export { OPENAI_VISION_MODELS } from '../catalogs/openai-vision';
export {
  OPENAI_IMAGE_MODELS,
  OPENAI_IMAGE_DEFAULT_MODEL,
} from '../catalogs/openai-image';
export {
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_STT_MODELS,
  ELEVENLABS_BASE_URL,
  ELEVENLABS_OUTPUT_FORMATS,
  ELEVENLABS_PREMADE_VOICES,
  mimeForElevenLabsFormat,
  type ElevenLabsTtsModel,
  type ElevenLabsOutputFormat,
} from '../catalogs/elevenlabs';
export {
  DEEPGRAM_BASE_URL,
  DEEPGRAM_STT_MODELS,
} from '../catalogs/deepgram';
export {
  ASSEMBLYAI_BASE_URL,
  ASSEMBLYAI_STT_MODELS,
  ASSEMBLYAI_POLL_TIMEOUT_SECONDS,
} from '../catalogs/assemblyai';
