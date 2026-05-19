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
  registerChatAdapter,
  registerSttAdapter,
  registerTtsAdapter,
} from './registry';
import { openAiTtsAdapter } from './openai-tts';
import { openAiSttAdapter } from './openai-stt';
import { xaiChatAdapter } from './xai-chat';
import { huggingfaceChatAdapter } from './huggingface-chat';
import { anthropicChatAdapter } from './anthropic-chat';
import { googleChatAdapter } from './google-chat';
import { elevenLabsTtsAdapter } from './elevenlabs-tts';

// Built-in adapters. Order doesn't matter — these are just into a
// Map keyed by providerId.
registerTtsAdapter(openAiTtsAdapter);
registerTtsAdapter(elevenLabsTtsAdapter);
registerSttAdapter(openAiSttAdapter);
registerChatAdapter(xaiChatAdapter);
registerChatAdapter(huggingfaceChatAdapter);
registerChatAdapter(anthropicChatAdapter);
registerChatAdapter(googleChatAdapter);

export {
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
  type ImageGenDispatcher,
  type AdapterMeta,
} from './types';

// Re-export the built-in adapter objects so apps can compose them
// (e.g. for testing against a mocked HTTP layer).
export { openAiTtsAdapter } from './openai-tts';
export { openAiSttAdapter } from './openai-stt';
export { xaiChatAdapter } from './xai-chat';
export {
  huggingfaceChatAdapter,
  HUGGINGFACE_ROUTING_POLICIES,
  type HuggingfaceRoutingPolicy,
} from './huggingface-chat';
export { anthropicChatAdapter } from './anthropic-chat';
export { googleChatAdapter } from './google-chat';
export { elevenLabsTtsAdapter } from './elevenlabs-tts';

// Catalogues — exposed so the UI can render the static list before
// live discovery completes.
export { XAI_CHAT_MODELS, XAI_BASE_URL } from '../catalogs/xai';
export {
  HUGGINGFACE_CHAT_MODELS,
  HUGGINGFACE_BASE_URL,
} from '../catalogs/huggingface';
export {
  ANTHROPIC_CHAT_MODELS,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_API_VERSION,
} from '../catalogs/anthropic';
export { GOOGLE_CHAT_MODELS, GOOGLE_BASE_URL } from '../catalogs/google';
export {
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_BASE_URL,
  ELEVENLABS_OUTPUT_FORMATS,
  ELEVENLABS_PREMADE_VOICES,
  mimeForElevenLabsFormat,
  type ElevenLabsTtsModel,
  type ElevenLabsOutputFormat,
} from '../catalogs/elevenlabs';
