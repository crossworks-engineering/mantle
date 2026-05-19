/**
 * OpenAI STT adapter (Whisper + gpt-4o-mini-transcribe family).
 *
 * Same thin-wrapper pattern as the TTS adapter — the real work is in
 * `transcribe.ts` and `discover.ts`. The adapter just exposes them
 * via the dispatcher interface so the runtime can resolve providers
 * uniformly.
 *
 * Future siblings: `deepgram-stt.ts` (live streaming-friendly),
 * `assemblyai-stt.ts` (diarization + sentiment). Each implements
 * `SttDispatcher`, gets imported in `./index.ts`, lights up in the UI.
 */

import { transcribeAudio } from '../transcribe';
import { discoverSttModels } from '../discover';
import type { SttDispatcher } from './types';

export const openAiSttAdapter: SttDispatcher = {
  providerId: 'openai',
  adapterName: 'openai-stt',
  async transcribe(audio, opts) {
    return transcribeAudio(audio, opts);
  },
  async discoverModels(apiKey) {
    return discoverSttModels(apiKey);
  },
};
