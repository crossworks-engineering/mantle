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
 *  benefit so it knows when to use which.
 *
 *  Inline tags are *point-in-time* — they fire at the spot they sit.
 *  For tags that style a whole *span* of text (e.g. xAI's
 *  `<whisper>…</whisper>`), see {@link WrappingTag}. */
export type AudioTag = {
  /** Exact form including brackets, e.g. `[laughs]`, `[whispers]`. */
  tag: string;
  /** One-line hint for the LLM. The composer joins these into the
   *  system-prompt paragraph so Saskia knows what each tag does. */
  description: string;
  /** Coarse grouping so the UI hint can render them in sections. */
  category?: 'emotion' | 'reaction' | 'delivery' | 'cognitive' | 'tone' | 'accent';
};

/** A wrapping speech tag — an angle-bracket pair that styles the whole
 *  phrase it surrounds, e.g. xAI Grok's `<whisper>secret</whisper>`,
 *  `<soft>…</soft>`, `<slow>…</slow>`. Distinct from {@link AudioTag}:
 *  inline tags are point-in-time cues, wrapping tags apply a delivery
 *  style across a span.
 *
 *  The framework treats these the same way it treats inline tags:
 *  adapters advertise the set their model honours (`supportedWrappingTags`),
 *  the prompt composer tells Saskia she may use them, and the text-out
 *  path strips them (keeping the inner text) so the markers never leak
 *  into a plain-text reply. */
export type WrappingTag = {
  /** Short lower-case name without brackets, e.g. `whisper`, `soft`.
   *  The open/close forms are derived as `<name>` / `</name>`. */
  name: string;
  /** One-line hint for the LLM — what the style does and when to reach
   *  for it. Joined into the system-prompt paragraph. */
  description: string;
  /** Coarse grouping for the UI hint (volume / pitch / pacing / style). */
  category?: 'volume' | 'pitch' | 'pacing' | 'style';
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

  /** Optional. Wrapping speech tags the model honours —
   *  `<whisper>…</whisper>`, `<soft>…</soft>`, `<slow>…</slow>`, etc.
   *  (xAI Grok voice today). Same contract as {@link supportedAudioTags}
   *  but for span-styling rather than point-in-time cues. Adapters
   *  whose providers have no angle-bracket wrapping vocabulary return
   *  [] (or omit this), and the runtime simply won't advertise any. */
  supportedWrappingTags?(modelId: string): readonly WrappingTag[];
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
 *  adapter we're likely to write speaks that dialect.
 *
 *  Cache + cost fields are optional because not every provider reports
 *  them. The runtime treats `undefined` as "this provider doesn't tell
 *  us" and falls back to the static price table for cost; cache fields
 *  stay zero in the trace. Adapters MUST populate `tokensIn`/`tokensOut`
 *  when the provider returns them (every chat API in the catalogue does)
 *  so the trace's token + fallback-cost numbers stay accurate. */
export interface ChatResult {
  text: string;
  model: string;
  /** Tool calls the model wants to make. When non-empty, the
   *  tool-loop dispatches each one and feeds results back. Adapters
   *  normalise from their provider's native shape (Anthropic
   *  `tool_use` blocks, Google `functionCall` parts, OpenAI
   *  `tool_calls`) to this single grammar.
   *
   *  Important: when toolCalls is non-empty, `text` may be empty —
   *  the model emitted only tool calls and no narrative this turn. */
  toolCalls?: ChatToolCall[];
  tokensIn?: number;
  tokensOut?: number;
  /** Tokens served from the provider's prompt cache, billed at the
   *  reduced cache-read rate. Anthropic returns this as
   *  `cache_read_input_tokens`; OpenAI as `prompt_tokens_details.cached_tokens`;
   *  Google as `usageMetadata.cachedContentTokenCount`; OpenRouter
   *  aliases all of the above as `cache_read_input_tokens` /
   *  `cached_tokens`. The trace records this separately from
   *  `tokensIn` so the cost dashboard can show the actual cache-read
   *  savings on the responder path. */
  cacheReadTokens?: number;
  /** Tokens *written* into the provider's prompt cache, billed at the
   *  cache-write rate (Anthropic charges ~1.25× input for these). Only
   *  Anthropic surfaces this distinctly (`cache_creation_input_tokens`);
   *  every other provider folds it into `tokensIn`. */
  cacheWriteTokens?: number;
  /** Provider-reported USD cost for the call, in dollars (not micro-USD).
   *  Currently only OpenRouter populates this via `usage.cost` — and it
   *  matters because OR rolls in vendor surcharges that the static price
   *  table doesn't know about (e.g. Perplexity's per-search fee). Direct
   *  providers return `undefined` here; the trace falls back to
   *  `fallbackCostMicroUsd(model, ...)`. */
  reportedCostUsd?: number;
}

/** A single tool the model can call. Mirrors the OpenAI function-tool
 *  shape since every adapter we're likely to talk to either accepts
 *  this natively (OpenRouter / xAI / HF) or translates from it
 *  (Anthropic `tool_use`, Google `functionDeclarations`). */
export interface ChatToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    /** JSON Schema describing the tool's arguments. Pass the same
     *  shape your `tools` table's `input_schema` carries. */
    parameters: Record<string, unknown>;
  };
}

/** One tool call returned by the model. Adapters normalise from
 *  provider-specific shapes (Anthropic `tool_use` blocks, Google
 *  `functionCall` parts) to this single shape so the tool-loop only
 *  iterates one grammar. */
export interface ChatToolCall {
  /** Provider-assigned id, used to pair the tool result back in the
   *  next request. For Anthropic this is the `tool_use.id` (toolu_*);
   *  for OpenAI-shape providers it's `tool_calls[].id` (call_*); for
   *  Google we synthesise an id since Gemini's functionCall has no
   *  natural id field. */
  id: string;
  type: 'function';
  function: {
    name: string;
    /** Stringified JSON args. Anthropic returns a parsed object as
     *  `input`; the adapter stringifies it here so the loop sees a
     *  single shape. Callers parse via @mantle/agent-runtime/tool-args
     *  defensively because not every model emits valid JSON. */
    arguments: string;
  };
}

/** A tool message in the conversation — i.e. the user-facing surface
 *  of "here's what the tool returned." Adapters translate to the
 *  provider's native tool-result shape (Anthropic emits this as a
 *  `user` message with a `tool_result` block; Google as a `function`
 *  message with `functionResponse`; OpenAI/OR/HF as a `tool` message). */
export type ChatToolMessage = {
  role: 'tool';
  toolCallId: string;
  /** The tool result, already serialised to a string. */
  content: string;
  /** The tool threw / returned an error. Cache-aware adapters (Anthropic) set
   *  the provider's `is_error` flag so the model treats it as a failure rather
   *  than inferring from the serialised body. Providers without the concept
   *  ignore it. */
  isError?: boolean;
};

/** Assistant turn — can carry text content, tool calls, or both. The
 *  tool-loop pushes this back into the conversation after each LLM
 *  round so the next request sees the model's prior tool_use + the
 *  matching tool_result pairs. */
export type ChatAssistantMessage = {
  role: 'assistant';
  /** Null when the model only emitted tool calls (no text turn). */
  content: string | null;
  toolCalls?: ChatToolCall[];
};

/** A multi-modal user content part. Used when the responder receives
 *  an image attachment — the runtime builds `[{type:'text', text}, {type:
 *  'image_url', imageUrl: {url, detail}}]` so vision-capable models
 *  see both the text and the image. Adapters that target a
 *  vision-capable provider translate; adapters that don't either
 *  extract just the text or warn at the call boundary. */
export type ChatUserContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      imageUrl: { url: string; detail?: 'auto' | 'low' | 'high' };
    };

/** A system-message content block. Used when the system prompt is
 *  composed of multiple cacheable segments (the responder splits its
 *  system prompt into the persona block + the conversation digest
 *  block, each with its own cache_control marker so prefix matches
 *  hit on shorter shared subsequences). */
export type ChatSystemContentPart = {
  type: 'text';
  text: string;
  cacheControl?: { type: 'ephemeral' };
};

/** The tool-loop-shaped message union. Wider than the simpler
 *  string-content shape because tool-loop calls grow assistant turns
 *  with toolCalls, tool result messages, multi-modal user turns
 *  (image + text), and multi-segment cacheable system blocks (persona
 *  + digest each marked separately on Anthropic-shape providers).
 *  The 3a chat-shaped workers structurally satisfy this union with a
 *  plain `{role, content: string}` array. */
export type ChatToolLoopMessage =
  | { role: 'system'; content: string | ChatSystemContentPart[] }
  | { role: 'user'; content: string | ChatUserContentPart[] }
  | ChatAssistantMessage
  | ChatToolMessage;

/** Prompt-cache hints for the adapter. Anthropic and (less aggressively)
 *  OpenAI bill cached input at a fraction of the fresh rate when the
 *  caller marks cache breakpoints. The runtime tells the adapter where
 *  the breakpoints should land via this struct; adapters that talk to
 *  providers without prompt caching ignore the field entirely.
 *
 *  Two breakpoint kinds matter today:
 *   - **systemPrompt** — mark the system block as cacheable. This is the
 *     dominant cost-saving on the responder path: the persona + skills
 *     block doesn't change turn-to-turn, so caching it pays back from
 *     the second call onward.
 *   - **lastUserMessage** — mark the most recent user message as a
 *     cache write point. Useful for the tool-loop pattern where the
 *     re-sent conversation history grows monotonically; marking the
 *     prior turn's last user msg makes the next call read it back as
 *     a cache hit. */
export interface ChatCacheControl {
  systemPrompt?: boolean;
  lastUserMessage?: boolean;
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  /** Standard chat-completion messages. The adapter is free to
   *  transform these into the provider's native shape (e.g. Anthropic's
   *  separate `system` field), but we present a uniform interface.
   *
   *  The grammar is `ChatToolLoopMessage[]` — wide enough to carry the
   *  tool-loop path (assistant turns with `toolCalls`, `tool` result
   *  messages) AND structurally compatible with the simpler shape every
   *  chat-shaped worker (extractor / summarizer / reflector) emits: a
   *  plain `{role, content: string}[]` array is a valid
   *  ChatToolLoopMessage[] for `system`/`user` roles. */
  messages: ChatToolLoopMessage[];
  /** Tools the model is allowed to call. Adapters translate this to
   *  the provider's native function-tool shape. When omitted or empty,
   *  the adapter MUST NOT send the field — some providers reject empty
   *  tool arrays. */
  tools?: ChatToolDefinition[];
  /** Steering hint for tool selection. The runtime only uses 'auto'
   *  (default) and 'none' today; we expose the OpenAI-style union so
   *  forcing a specific tool is a non-breaking addition later. */
  toolChoice?: 'auto' | 'none';
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** Retries AFTER the first attempt on transient errors (429/5xx/network/
   *  timeout), with exponential backoff + jitter. Undefined ⇒
   *  DEFAULT_MAX_RETRIES (2); 0 disables. Honored by withChatRetry, which the
   *  registry applies to the direct-provider adapters (OpenRouter relies on
   *  its SDK's own retries). */
  maxRetries?: number;
  /** Provider-neutral prompt-cache hints. See {@link ChatCacheControl}.
   *  Adapters that don't talk to a cache-aware provider ignore this. */
  cacheControl?: ChatCacheControl;
  /** Optional provider-specific overrides — adapter chooses what to honour.
   *  Used for things like xAI's `reasoning_effort` or HF's `:fastest`
   *  routing suffix. */
  extra?: Record<string, unknown>;
  /** Per-route base URL override for self-hosted / OpenAI-compatible chat
   *  servers. Lets a `local` chat route target a specific host (a LAN/tailnet
   *  box). The `local-chat` adapter honours it; fixed-endpoint cloud adapters
   *  ignore it. Mirrors `EmbedRequest.baseUrl`. */
  baseUrl?: string;
  /** When true, the request is dispatched through the Tailscale forward-proxy
   *  ({@link tailnetFetch}) so a `baseUrl` pointing at a tailnet host reaches a
   *  box behind NAT. Honoured by the `local-chat` adapter; inert when no proxy
   *  is configured. */
  viaTailnet?: boolean;
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

  /** Optional. Extract text from a document (PDF) sent NATIVELY to the model —
   *  no rasterization. Providers whose API accepts a document content block
   *  (Anthropic, Google) implement this; the runtime PREFERS it over
   *  rasterize→per-page image OCR for PDFs (whole-document context, real layout
   *  and tables, one call, no PNG-conversion fidelity loss). Adapters that
   *  can't take a document natively (OpenAI, xAI) omit it, and the caller falls
   *  back to rasterizing the pages through `extract`. `opts.mimeType` is the
   *  document MIME (e.g. 'application/pdf'). */
  extractDocument?(document: Buffer, opts: VisionExtractOptions): Promise<VisionExtractResult>;

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

// ─── Embedding ──────────────────────────────────────────────────────

/** A text→vector model entry. Embedding pricing is input-only
 *  (the response is the vector, not a token stream — no output cost
 *  to bill). Native `dimensions` is exposed so the form can verify
 *  compatibility with the brain's `vector(768)` column before save. */
export interface EmbeddingModelInfo {
  id: string;
  label: string;
  description: string;
  /** Maximum input tokens accepted in a single call. */
  contextTokens?: number;
  /** USD per 1M input tokens. */
  inputPricePer1M?: number;
  /** Output vector dimension as the provider documents it. The form
   *  uses this to drive the dim-mismatch save block before the
   *  operator gets a 'won't insert' surprise at runtime. */
  dimensions?: number;
  /** Accepts non-text inputs (image / audio / file). Only OpenRouter's
   *  multimodal route and Google's gemini-embedding-2-preview today. */
  multimodal?: boolean;
}

/** Inputs the embedding dispatchers accept. Same shape as the
 *  pre-adapter @mantle/embeddings package — keeps the public API
 *  stable while the dispatch path swaps underneath. */
export type EmbedInput =
  | string
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'audio'; url: string }
  | { type: 'file'; url: string; mimeType?: string };

export interface EmbedRequest {
  apiKey: string;
  model: string;
  /** Single-element array for single-text calls; batch is the common path
   *  (extractor + recall batch many at once for cache + API efficiency). */
  input: EmbedInput[];
  /** Truncate to this dim where supported. OpenAI's text-embedding-3-*
   *  family honours it (truncation by MRL); Google's gemini-embedding-2
   *  honours it as `output_dimensionality`. Everything else ignores. */
  dimensions?: number;
  /** Per-call base URL override for self-hosted / OpenAI-compatible routes.
   *  Lets the embedding config point primary and backup at different hosts
   *  serving the SAME model (failover). The `local` adapter honours it;
   *  fixed-endpoint cloud adapters ignore it. */
  baseUrl?: string;
  /** When true, the request is dispatched through the Tailscale forward-proxy
   *  ({@link tailnetFetch}) so a `baseUrl` pointing at a tailnet host reaches a
   *  box behind NAT. Honoured by the `local-embedding` adapter; inert when no
   *  proxy is configured. */
  viaTailnet?: boolean;
  /** Texts per HTTP request for the `local-embedding` adapter. Lets the embedding
   *  config tune throughput per-owner (small on a CPU box so a request fits the
   *  timeout, large on a GPU). Null/undefined → the adapter's own
   *  `MANTLE_LOCAL_EMBED_BATCH` env → 16. Ignored by cloud adapters. */
  localEmbedBatchSize?: number;
  /** Per-request timeout (ms) for the `local-embedding` adapter. Null/undefined
   *  → `MANTLE_LOCAL_EMBED_TIMEOUT_MS` env → 120000. Ignored by cloud adapters. */
  localEmbedTimeoutMs?: number;
}

export interface EmbedResult {
  vectors: number[][];
  /** Server-reported model id (so callers can verify their slug landed
   *  where they expected — direct providers sometimes alias). */
  model: string;
  /** Total input tokens billed. Undefined when the provider doesn't
   *  report (Cohere v2 omits, some HF routes too). */
  tokensIn?: number;
}

export interface EmbeddingDispatcher extends AdapterMeta {
  /** Embed a batch. Adapters that don't support multimodal input throw
   *  a clear error on non-text items rather than silently truncating —
   *  surfaces "you picked a text-only model but sent an image" at the
   *  point of failure rather than as a confused empty result. */
  embed(req: EmbedRequest): Promise<EmbedResult>;

  /** Optional: whether this adapter will accept the given input. Text-only
   *  adapters return false for non-text items so the caller can route
   *  multimodal inputs to OpenRouter (the only multimodal-capable path)
   *  instead of failing at request time. Default = true. */
  acceptsInput?(input: EmbedInput): boolean;

  /** Live-discover available embedding models. Each adapter does the
   *  cross-reference between its provider's list endpoint and its own
   *  static catalog. OpenRouter publishes `/v1/embeddings/models`
   *  separately from `/v1/models`; OpenAI returns embeddings inline
   *  in `/v1/models` (filtered by id pattern); Google requires a
   *  capability filter (`supportedGenerationMethods` includes
   *  `embedContent`). */
  discoverModels?(apiKey: string): Promise<DiscoveryResult<EmbeddingModelInfo>>;

  /** Curated fallback list. Used by the workers form when no API key
   *  is configured yet (so the dropdown isn't empty in create mode)
   *  AND as a last-resort if discovery errors. */
  staticCatalog?(): readonly EmbeddingModelInfo[];
}

