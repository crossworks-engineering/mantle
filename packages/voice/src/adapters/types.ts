/**
 * Adapter interfaces — the boundary between the rest of Mantle and
 * provider-specific HTTP calls.
 *
 * One interface per capability. Each provider that wants to be "wired"
 * for a capability implements the matching interface. The runtime
 * looks up the right adapter by `providerId` (which comes from the
 * worker's `provider` column) and calls through it. The dispatch
 * surface is identical regardless of provider — the adapter handles
 * all the per-provider quirks (auth header shape, response decoding,
 * voice/model naming).
 *
 * Why we own these instead of using LiteLLM:
 *   - End-to-end type safety. The adapter's input/output shapes are
 *     fixed at compile time.
 *   - No proxy service to operate on the VPS.
 *   - Adapters are ~50-150 LOC each. Total maintenance cost is small
 *     because we only adapter the providers we actually use.
 *   - LiteLLM's open-source code remains a reference we can lift from
 *     when a provider's API shape is surprising.
 *
 * Each adapter exposes its `providerId` (must match the catalogue in
 * `providers.ts`) and an `adapterName` used purely for logs/traces so
 * we can tell at a glance which adapter ran a given call.
 */

import type { ProviderId } from '../providers';
import type {
  SynthesizeOptions,
  SynthesizeResult,
  TranscribeOptions,
  TranscribeResult,
} from '../types';
import type { TtsModelInfo, SttModelInfo } from '../catalog';
import type { DiscoveryResult } from '../discover';

/** Common shape every adapter exposes — used by the registry to log
 *  and surface the right one in errors. */
export interface AdapterMeta {
  /** Matches one of the ids in SUPPORTED_PROVIDERS. */
  readonly providerId: ProviderId;
  /** Human-readable for logs. Convention: '<provider>-<capability>'
   *  (e.g. 'openai-tts', 'elevenlabs-tts'). */
  readonly adapterName: string;
}

/** An inline audio tag the model interprets as a performance cue.
 *  ElevenLabs v3 calls these "audio tags"; xAI's voice models use a
 *  similar `[giggle]`/`[laugh]` convention. The shape is uniform: an
 *  exact bracket-wrapped token + a short description for the LLM's
 *  benefit so it knows when to use which. */
export type AudioTag = {
  /** Exact form including brackets, e.g. `[laughs]`, `[whispers]`. */
  tag: string;
  /** One-line hint for the LLM. The composer joins these into the
   *  system-prompt paragraph so Saskia knows what each tag does. */
  description: string;
  /** Coarse grouping so the UI hint can render them in sections. */
  category?: 'emotion' | 'reaction' | 'delivery' | 'cognitive' | 'tone' | 'accent';
};

export interface TtsDispatcher extends AdapterMeta {
  /** Synthesise speech and return audio bytes. The runtime then hands
   *  these to Telegram's sendVoice (when format='opus') or to an
   *  `<audio>` element on the web. */
  synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult>;

  /** Optional. Live-discover which TTS models the API key can use.
   *  For OpenAI we hit /v1/models and intersect with the catalogue;
   *  for ElevenLabs we'd hit /v1/models too but the catalogue is
   *  different. If absent, the UI falls back to whatever static
   *  catalogue the adapter consults. */
  discoverModels?(apiKey: string): Promise<DiscoveryResult<TtsModelInfo>>;

  /** Optional. Returns the voices a given model supports. For OpenAI
   *  this is a static per-model list (we hardcode 13 voices for
   *  gpt-4o-mini-tts, 9 for tts-1). For ElevenLabs this would be a
   *  live `/v1/voices` query that includes the user's cloned voices.
   *  When absent, callers fall through to whatever default they
   *  rendered the form with. */
  voicesForModel?(
    modelId: string,
    apiKey?: string,
  ): Promise<Array<{ id: string; description: string }>>;

  /** Optional. Inline audio tags the model interprets — `[laughs]`,
   *  `[whispers]`, `[sighs]`, etc. ElevenLabs v3 has the richest set;
   *  xAI's voice models support a smaller subset; OpenAI's
   *  gpt-4o-mini-tts uses the `instructions` parameter instead and
   *  returns an empty list here.
   *
   *  The runtime queries this when building the chat agent's prompt
   *  so the LLM only emits tags the active TTS will render. Adapters
   *  whose providers ignore unknown tags can safely return [] —
   *  Saskia won't try to use them. */
  supportedAudioTags?(modelId: string): readonly AudioTag[];
}

/** A chat model entry. The fields are intentionally generic — provider
 *  catalogs (xAI, HF, OpenAI…) all describe their chat models in
 *  roughly this shape. Pricing is included so the UI can show a
 *  rough cost-per-1M-tokens estimate when picking a model. */
export interface ChatModelInfo {
  id: string;
  label: string;
  description: string;
  /** Context window in tokens. */
  contextTokens?: number;
  /** Capabilities beyond plain chat. */
  capabilities?: readonly ('vision' | 'reasoning' | 'function_calling' | 'json_mode')[];
  /** USD per 1M input tokens. Approximate; for UI hints only. */
  inputPricePer1M?: number;
  /** USD per 1M output tokens. */
  outputPricePer1M?: number;
}

/** Result of a chat completion. Mirrors the OpenAI shape since every
 *  adapter we're likely to write speaks that dialect. */
export interface ChatResult {
  text: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  /** Standard chat-completion messages. The adapter is free to
   *  transform these into the provider's native shape (e.g. Anthropic's
   *  separate `system` field), but we present a uniform interface. */
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** Optional provider-specific overrides — adapter chooses what to honour.
   *  Used for things like xAI's `reasoning_effort` or HF's `:fastest`
   *  routing suffix. */
  extra?: Record<string, unknown>;
}

export interface ChatDispatcher extends AdapterMeta {
  /** One-shot chat completion. Streaming is intentionally NOT on the
   *  interface — none of Mantle's current callers stream, and adding
   *  streaming later is a non-breaking expansion. */
  chat(opts: ChatOptions): Promise<ChatResult>;
  /** Live-discover available chat models. Adapter does the cross-
   *  reference between provider's /v1/models response and its own
   *  static catalog. */
  discoverModels?(apiKey: string): Promise<DiscoveryResult<ChatModelInfo>>;
  /** Adapters expose their static catalog for the UI to render before
   *  discovery completes (or when discovery isn't supported). */
  staticCatalog?(): readonly ChatModelInfo[];
}

export interface SttDispatcher extends AdapterMeta {
  /** Transcribe an audio buffer. Buffer must be in one of the formats
   *  the provider accepts; the adapter handles the multipart encoding
   *  and any provider-specific MIME wrangling. */
  transcribe(audio: Buffer, opts: TranscribeOptions): Promise<TranscribeResult>;

  /** Optional. Live-discover available transcription models. */
  discoverModels?(apiKey: string): Promise<DiscoveryResult<SttModelInfo>>;
}

// ─── Vision ─────────────────────────────────────────────────────────

/** A vision-capable model entry. Same generic shape as ChatModelInfo;
 *  the form's vision-worker dropdown renders these so operators pick
 *  from a list rather than typing a model id by hand. */
export interface VisionModelInfo {
  id: string;
  label: string;
  description: string;
  /** Context window in tokens. */
  contextTokens?: number;
  /** USD per 1M input tokens. Approximate; for UI hints only. */
  inputPricePer1M?: number;
  /** USD per 1M output tokens. */
  outputPricePer1M?: number;
  /** Roughly which tier the model fits. 'fast' = use for high volume;
   *  'balanced' = default; 'quality' = harder images, lower throughput. */
  tier?: 'fast' | 'balanced' | 'quality';
}

export interface VisionExtractOptions {
  apiKey: string;
  /** MIME of the image bytes (image/jpeg, image/png, image/webp, image/gif).
   *  Each provider accepts a slightly different list — adapters error
   *  on unsupported MIMEs rather than silently sending bytes the API
   *  will reject downstream. */
  mimeType: string;
  /** User-side prompt — "transcribe this page verbatim", "summarize
   *  the diagram", "extract action items as a list". Adapters pass it
   *  through alongside the image, framed as the user turn. */
  prompt: string;
  /** Optional system-level steering (used the same way as a chat
   *  worker's system prompt). Operators set this on the worker row;
   *  callers forward it here. */
  systemPrompt?: string;
  /** Model id. Falls back to the adapter's documented default if
   *  omitted. */
  model?: string;
  /** Max output tokens. Vision-LLMs can run long without one. */
  maxTokens?: number;
}

export interface VisionExtractResult {
  /** Extracted text. Trimmed; empty string on no-output, not null. */
  text: string;
  /** Model that did the work. May be a more specific id than the
   *  caller passed in (e.g. dated Claude variants). */
  model: string;
  /** Token usage when the provider returns it. */
  tokensIn?: number;
  tokensOut?: number;
}

export interface VisionDispatcher extends AdapterMeta {
  /** Extract text/structure from an image. The adapter handles the
   *  per-provider message shape, MIME validation, and image encoding
   *  (base64 vs URL). Caller hands raw bytes + a prompt; result is
   *  trimmed text. */
  extract(image: Buffer, opts: VisionExtractOptions): Promise<VisionExtractResult>;

  /** Live-discover which vision-capable models the api key can use.
   *  Implementation parity with ChatDispatcher.discoverModels — when
   *  absent, the form falls back to the adapter's static catalog. */
  discoverModels?(apiKey: string): Promise<import('../discover').DiscoveryResult<VisionModelInfo>>;

  /** Static catalog the UI renders before live discovery returns or
   *  when the adapter doesn't support discovery. */
  staticCatalog?(): readonly VisionModelInfo[];
}

// ─── Image generation ───────────────────────────────────────────────

/** A generatable image model entry. Same shape conventions as
 *  ChatModelInfo/VisionModelInfo: id + label + description so the UI
 *  has rich dropdown options without each form re-parsing provider
 *  docs. */
export interface ImageGenModelInfo {
  id: string;
  label: string;
  description: string;
  /** Native resolutions the model accepts. Adapters reject sizes
   *  outside this list with a clear error. Free-form when undefined
   *  (HF models, where the underlying model decides). */
  supportedSizes?: readonly string[];
  /** Steerable styles, when the model supports them (DALL-E 3:
   *  'vivid' | 'natural'). Undefined = no style steering. */
  supportedStyles?: readonly string[];
  /** USD per image at default size. UI hint only. */
  pricePerImage?: number;
  /** Latency tier — useful when picking between same-provider models. */
  tier?: 'fast' | 'balanced' | 'quality';
}

export interface GenerateImageOptions {
  apiKey: string;
  /** Free-form prompt. No length cap at the interface layer; per-
   *  provider limits get enforced inside the adapter. */
  prompt: string;
  /** Model id. Defaults to the adapter's documented default. */
  model?: string;
  /** Native resolution, e.g. '1024x1024' or '1792x1024'. Adapters
   *  validate against ImageGenModelInfo.supportedSizes. */
  size?: string;
  /** Style hint (provider-specific: DALL-E 3 = 'vivid'/'natural';
   *  others may ignore). */
  style?: string;
  /** Quality tier — DALL-E 3 uses 'standard'/'hd'; HF models may use
   *  'fast'/'balanced'/'quality'. Adapters ignore unknown values. */
  quality?: string;
  /** Negative prompt — what the image should NOT contain. Honoured
   *  by HF + Imagen; OpenAI doesn't accept it (silently ignored). */
  negativePrompt?: string;
  /** Random seed for reproducibility, when the provider exposes one. */
  seed?: number;
}

export interface GenerateImageResult {
  /** Generated image bytes. Adapters always materialize the bytes
   *  even when the provider returns a URL — callers shouldn't have
   *  to deal with URL-vs-bytes asymmetry across providers. */
  bytes: Buffer;
  /** MIME of the returned image — typically 'image/png' but Imagen
   *  may return jpeg, HF may return jpeg/png depending on model. */
  mimeType: string;
  /** Model id that did the work. Echoed back for traces. */
  model: string;
  /** Provider's revised prompt, when it returns one (DALL-E 3 rewrites
   *  the user prompt for safety+quality and surfaces the revision).
   *  Caller can pass this back as `revised_prompt` metadata on the
   *  saved file node so the operator sees what the model actually
   *  rendered against. */
  revisedPrompt?: string;
}

export interface ImageGenDispatcher extends AdapterMeta {
  /** Generate an image from a prompt. Throws on auth/network/quota
   *  errors with the provider's verbatim message slice — same
   *  convention as the other dispatchers. */
  generate(opts: GenerateImageOptions): Promise<GenerateImageResult>;

  /** Static catalog the UI renders for the model dropdown. Most
   *  image-gen providers don't expose a programmatic models list
   *  (or they do but it returns chat models too) — so we ship a
   *  curated static list and don't implement discoverModels. */
  staticCatalog(): readonly ImageGenModelInfo[];
}

