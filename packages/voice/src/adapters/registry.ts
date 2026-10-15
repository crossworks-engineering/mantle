import type {
  ChatDispatcher,
  DecisionDispatcher,
  EmbeddingDispatcher,
  ImageGenDispatcher,
  SttDispatcher,
  TtsDispatcher,
  VisionDispatcher,
} from './types';
import {
  getDecisionAdapter as registeredDecisionAdapter,
  getEmbeddingAdapter as registeredEmbeddingAdapter,
  getImageGenAdapter as registeredImageGenAdapter,
  getSttAdapter as registeredSttAdapter,
  getTtsAdapter as registeredTtsAdapter,
  getVisionAdapter as registeredVisionAdapter,
  listChatAdapters as registeredChatAdapters,
  listEmbeddingAdapters as registeredEmbeddingAdapters,
  listSttAdapters as registeredSttAdapters,
  listTtsAdapters as registeredTtsAdapters,
  registeredChatAdapter,
} from '@mantle/voice-client/adapters/registry';
import { withChatRetry } from './retry';
import {
  recordingChat,
  recordingDecision,
  recordingEmbedding,
  recordingImageGen,
  recordingStt,
  recordingTts,
  recordingVision,
} from './spend';

// The lookups below shadow the contract package's unwrapped ones of the same
// name: every adapter handed out here records its spend (./spend.ts, A10 #5).
export * from '@mantle/voice-client/adapters/registry';

/**
 * The chat adapter for a provider, ready to call. OpenRouter's SDK already
 * retries transient errors internally; wrapping it would compound attempt
 * counts. The native-fetch adapters (anthropic / google / xai / huggingface /
 * deepseek / ...) have no retry of their own, so they are wrapped here once
 * for uniform 429/5xx/network/timeout backoff (./retry.ts). The spend
 * recording sits outside the retry: one recording per answered call.
 */
export function getChatAdapter(providerId: string): ChatDispatcher | null {
  const adapter = registeredChatAdapter(providerId);
  if (!adapter) return null;
  return recordingChat(adapter.providerId === 'openrouter' ? adapter : withChatRetry(adapter));
}

export function getTtsAdapter(providerId: string): TtsDispatcher | null {
  const adapter = registeredTtsAdapter(providerId);
  return adapter ? recordingTts(adapter) : null;
}

export function getSttAdapter(providerId: string): SttDispatcher | null {
  const adapter = registeredSttAdapter(providerId);
  return adapter ? recordingStt(adapter) : null;
}

export function getVisionAdapter(providerId: string): VisionDispatcher | null {
  const adapter = registeredVisionAdapter(providerId);
  return adapter ? recordingVision(adapter) : null;
}

export function getImageGenAdapter(providerId: string): ImageGenDispatcher | null {
  const adapter = registeredImageGenAdapter(providerId);
  return adapter ? recordingImageGen(adapter) : null;
}

export function getEmbeddingAdapter(providerId: string): EmbeddingDispatcher | null {
  const adapter = registeredEmbeddingAdapter(providerId);
  return adapter ? recordingEmbedding(adapter) : null;
}

/** No retry wrapper on purpose: a decision sits IN FRONT of a call the caller
 *  will make anyway, so a failed decision is simply "no decision". */
export function getDecisionAdapter(providerId: string): DecisionDispatcher | null {
  const adapter = registeredDecisionAdapter(providerId);
  return adapter ? recordingDecision(adapter) : null;
}

/** Every registered adapter of a capability, each as the lookup hands it out
 *  (recording, and for chat retrying). */
export function listChatAdapters(): ChatDispatcher[] {
  return registeredChatAdapters().flatMap((a) => getChatAdapter(a.providerId) ?? []);
}

export function listTtsAdapters(): TtsDispatcher[] {
  return registeredTtsAdapters().map(recordingTts);
}

export function listSttAdapters(): SttDispatcher[] {
  return registeredSttAdapters().map(recordingStt);
}

export function listEmbeddingAdapters(): EmbeddingDispatcher[] {
  return registeredEmbeddingAdapters().map(recordingEmbedding);
}
