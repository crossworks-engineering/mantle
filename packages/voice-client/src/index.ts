/**
 * Browser-safe surface of @mantle/voice.
 *
 * The main barrel (`index.ts`) does `export * from './adapters'`, which pulls
 * the network adapter layer (undici → node:crypto) — fine on the server, fatal
 * in a client bundle ("Module parse failed" / node builtin in the browser).
 * The UI settings pages only need *catalog data + provider metadata + pure
 * helpers*, all of which live in adapter-free modules. Import those from HERE
 * (`@mantle/voice/client`) instead of the barrel so the server adapters never
 * reach the browser. Mirrors the `@mantle/content/contacts-format` leaf pattern.
 *
 * Keep this list adapter-free: only re-export modules whose value imports are
 * empty (catalogs/*, catalog, providers, audio-tags) or pure metadata
 * (adapters/registry's `isProviderWired` / `wiredCapabilitiesFor`).
 */

// Provider catalogue + capability metadata (pure data + helpers).
export * from './providers';

// Voice/model catalogs + helpers.
export * from './catalog';
export * from './audio-tags';

// Per-provider model catalogs (data only).
export * from './catalogs/anthropic';
export * from './catalogs/google';
export * from './catalogs/xai';
export * from './catalogs/huggingface';
export * from './catalogs/openai-image';
export * from './catalogs/openai-vision';
export * from './catalogs/openrouter';
export * from './catalogs/elevenlabs';
export * from './catalogs/deepgram';
export * from './catalogs/assemblyai';
export * from './catalogs/deepseek';

// Pure wiring metadata (no adapter modules pulled — registry.ts only imports
// the retry helper, which is itself dependency-free).
export { isProviderWired, wiredCapabilitiesFor, WIRED_PROVIDERS } from './adapters/registry';
export type { WiredCapability } from './adapters/registry';

// Shared types.
export { TTS_VOICES } from './types';
export type { TtsVoice } from './types';
// adapters/types.ts is type-only (no value imports), so re-exporting its whole
// type surface is browser-safe and covers ChatModelInfo / VisionModelInfo /
// ImageGenModelInfo / AudioTag / WrappingTag that the worker form needs.
export type * from './adapters/types';
