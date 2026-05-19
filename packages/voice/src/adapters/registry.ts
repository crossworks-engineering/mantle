/**
 * Adapter registry — provider id → dispatcher lookup, per capability.
 *
 * Built-in adapters self-register at module load via the import chain
 * in `./index.ts`. Apps that want to add custom adapters at runtime
 * call `registerTtsAdapter(...)` etc. before the first use.
 *
 * Resolution is intentionally strict: if no adapter is registered for
 * a given `providerId`, the lookup returns null and the runtime
 * surfaces a clear "not yet wired" error rather than guessing. The
 * catalog's `wired` flag is derived from these registries so the UI
 * stays honest about which providers can actually be called.
 */

import type { ProviderId } from '../providers';
import type {
  ChatDispatcher,
  ImageGenDispatcher,
  SttDispatcher,
  TtsDispatcher,
  VisionDispatcher,
} from './types';

const CHAT = new Map<ProviderId, ChatDispatcher>();
const TTS = new Map<ProviderId, TtsDispatcher>();
const STT = new Map<ProviderId, SttDispatcher>();
const VISION = new Map<ProviderId, VisionDispatcher>();
const IMAGE_GEN = new Map<ProviderId, ImageGenDispatcher>();

// ─── Chat ────────────────────────────────────────────────────────────

export function registerChatAdapter(adapter: ChatDispatcher): void {
  CHAT.set(adapter.providerId, adapter);
}

export function getChatAdapter(providerId: string): ChatDispatcher | null {
  return CHAT.get(providerId as ProviderId) ?? null;
}

export function listChatAdapters(): ChatDispatcher[] {
  return Array.from(CHAT.values());
}

// ─── TTS ─────────────────────────────────────────────────────────────

export function registerTtsAdapter(adapter: TtsDispatcher): void {
  TTS.set(adapter.providerId, adapter);
}

export function getTtsAdapter(providerId: string): TtsDispatcher | null {
  return TTS.get(providerId as ProviderId) ?? null;
}

export function listTtsAdapters(): TtsDispatcher[] {
  return Array.from(TTS.values());
}

// ─── STT ─────────────────────────────────────────────────────────────

export function registerSttAdapter(adapter: SttDispatcher): void {
  STT.set(adapter.providerId, adapter);
}

export function getSttAdapter(providerId: string): SttDispatcher | null {
  return STT.get(providerId as ProviderId) ?? null;
}

export function listSttAdapters(): SttDispatcher[] {
  return Array.from(STT.values());
}

// ─── Vision (interface ready, no adapters yet) ───────────────────────

export function registerVisionAdapter(adapter: VisionDispatcher): void {
  VISION.set(adapter.providerId, adapter);
}

export function getVisionAdapter(providerId: string): VisionDispatcher | null {
  return VISION.get(providerId as ProviderId) ?? null;
}

// ─── Image generation (interface ready, no adapters yet) ─────────────

export function registerImageGenAdapter(adapter: ImageGenDispatcher): void {
  IMAGE_GEN.set(adapter.providerId, adapter);
}

export function getImageGenAdapter(providerId: string): ImageGenDispatcher | null {
  return IMAGE_GEN.get(providerId as ProviderId) ?? null;
}

// ─── Capability check (used by UI to derive `wired` flag) ────────────

/**
 * Is the given provider wired (i.e. has a registered adapter) for the
 * given capability? Drives the "wired" / "not yet wired" hint in the
 * settings UI so the catalog stays honest.
 */
export function isProviderWired(
  providerId: string,
  capability: 'tts' | 'stt' | 'vision' | 'image_gen' | 'chat' | 'embedding',
): boolean {
  switch (capability) {
    case 'tts':
      return TTS.has(providerId as ProviderId);
    case 'stt':
      return STT.has(providerId as ProviderId);
    case 'vision':
      return VISION.has(providerId as ProviderId);
    case 'image_gen':
      return IMAGE_GEN.has(providerId as ProviderId);
    case 'chat':
      // Chat is wired if EITHER a chat adapter is registered for this
      // provider, OR we're talking about openrouter/openai (the
      // legacy direct-SDK path that the responder/extractor/etc. use
      // today). New providers must register an adapter — that's how
      // xAI Grok and Hugging Face become wired.
      return (
        CHAT.has(providerId as ProviderId) ||
        providerId === 'openrouter' ||
        providerId === 'openai'
      );
    case 'embedding':
      // Embedding doesn't have an adapter registry yet (workers use
      // @mantle/embeddings inline). Treat the two providers we use as
      // wired by convention.
      return providerId === 'openrouter' || providerId === 'openai';
    default:
      return false;
  }
}
