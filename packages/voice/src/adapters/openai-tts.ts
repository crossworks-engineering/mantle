/**
 * OpenAI TTS adapter. Wraps the existing `synthesizeSpeech` and
 * `discoverTtsModels` so the runtime can resolve them via the adapter
 * registry like any other provider.
 *
 * This is intentionally a thin wrapper — the actual HTTP and parsing
 * logic still lives in `synthesize.ts` / `discover.ts` / `catalog.ts`
 * (where it's well-tested). The adapter just gives that code a
 * dispatcher-shaped face.
 *
 * Adding a second TTS provider (e.g. ElevenLabs) is the same shape:
 *   1. Write `elevenlabs-tts.ts` with the same interface.
 *   2. Import it in `./index.ts` so it self-registers.
 *   3. Done — the worker form's provider dropdown picks it up.
 */

import { synthesizeSpeech } from '../synthesize';
import { discoverTtsModels } from '../discover';
import { voicesForModel as voicesForModelStatic } from '../catalog';
import type { TtsDispatcher } from './types';

export const openAiTtsAdapter: TtsDispatcher = {
  providerId: 'openai',
  adapterName: 'openai-tts',
  async synthesize(opts) {
    return synthesizeSpeech(opts);
  },
  async discoverModels(apiKey) {
    return discoverTtsModels(apiKey);
  },
  async voicesForModel(modelId) {
    // OpenAI's voice list per model is static (documented, not
    // queryable). For ElevenLabs the equivalent would be a live
    // `/v1/voices` query that includes the user's cloned voices.
    return voicesForModelStatic(modelId).map((v) => ({
      id: v.id,
      description: v.description,
    }));
  },
};
