/**
 * Canonical catalog of AI providers Mantle supports.
 *
 * Why this exists: the `api_keys.service` column and the `ai_workers.
 * provider` column are both free text, and the runtime depends on
 * matching them exactly ('openai' triggers OpenAI dispatch, 'openrouter'
 * triggers OpenRouter dispatch, etc.). One typo and the entire path
 * breaks silently. This catalog gives the UI a closed set of options
 * — operators pick from a dropdown, not a freeform input — and gives
 * code a single source of truth for "which providers do we know about,
 * what can they do, where do I get a key."
 *
 * The list grows over time as we wire new dispatch paths. Adding a
 * provider here makes it APPEAR in the UI dropdowns; it does NOT
 * automatically make it work. The runtime still needs to know how to
 * call it — that's a separate code change. So treat new entries here
 * as "UI is ready, runtime work pending" until proven.
 *
 * The capabilities array per provider drives the worker-form filter:
 * a TTS worker only shows providers with 'tts' in their capabilities,
 * a vision worker shows ones with 'vision', etc. Aggregators (OpenRouter,
 * Hugging Face) cover many capabilities through one key.
 */

/** Stable string id used in code and persisted to api_keys.service /
 *  ai_workers.provider. Adding a new id is a public API change — the
 *  string must match what the runtime dispatch expects. */
export type ProviderId =
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'huggingface'
  | 'deepseek'
  | 'copilot'
  | 'mistral'
  | 'cohere'
  | 'deepgram'
  | 'elevenlabs'
  | 'assemblyai'
  | 'local';

/** What a provider can do. Mapped 1:1 to `ai_workers.kind` plus 'chat'
 *  (for conversational agents) and 'embedding' (for memory embeddings —
 *  configured separately for now, but lives in the same vocabulary).
 *
 *  When a new ai_workers kind ships, add its capability here too so
 *  the provider filter knows which providers to expose for that kind. */
export type ProviderCapability =
  | 'chat'
  | 'embedding'
  | 'tts'
  | 'stt'
  | 'vision'
  | 'image_gen';

export type Provider = {
  id: ProviderId;
  /** Display name shown in dropdowns. */
  label: string;
  /** One-sentence description shown as a hint when the option is selected. */
  description: string;
  /** Capabilities — drives dropdown filtering per worker kind. */
  capabilities: readonly ProviderCapability[];
  /** Where the user gets/manages an API key. Linked from the api-key
   *  create form so the user can hop straight to the right console. */
  signupUrl: string;
  /** Docs root. Linked from the worker edit form so the user can
   *  remind themselves what model names look like for this provider. */
  docsUrl: string;
  /** True for providers that proxy many model families through one
   *  key (OpenRouter, Hugging Face). Used by the UI to render a small
   *  "aggregator" badge so users understand why one provider covers
   *  so many capabilities. */
  isAggregator?: boolean;
};

/**
 * Catalog. Ordered so the most-used providers appear first in
 * dropdowns. OpenRouter is the default chat path; OpenAI is the
 * required audio path; everything else lives below.
 */
export const SUPPORTED_PROVIDERS: readonly Provider[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description:
      'Aggregator covering OpenAI, Anthropic, Google, Mistral, DeepSeek, and most open models behind one key — plus audio (TTS/STT) and image generation. One key powers chat, memory, voice, and images.',
    capabilities: ['chat', 'embedding', 'vision', 'tts', 'stt', 'image_gen'],
    signupUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs',
    isAggregator: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description:
      'Direct OpenAI access. Required for Whisper (STT), GPT-4o TTS voices, and DALL-E image generation — OpenRouter doesn’t proxy audio.',
    capabilities: ['chat', 'embedding', 'tts', 'stt', 'vision', 'image_gen'],
    signupUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (direct)',
    description:
      'Claude direct. Use this for Claude-specific features OpenRouter does not yet proxy (e.g. computer use, file APIs).',
    capabilities: ['chat', 'vision'],
    signupUrl: 'https://console.anthropic.com/account/keys',
    docsUrl: 'https://docs.anthropic.com',
  },
  {
    id: 'google',
    label: 'Google (Gemini)',
    description:
      'Gemini direct. Large-context chat + 30-voice TTS (Kore, Puck, Zephyr…). 1M+ token windows. STT via the multimodal generateContent endpoint (99 languages, inline audio up to 20 MB). Imagen 3/4 for image generation.',
    capabilities: ['chat', 'vision', 'embedding', 'tts', 'stt', 'image_gen'],
    signupUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    description:
      'Grok chat + Grok TTS (5 voices: eve, ara, rex, sal, leo) with [laugh]/[giggle]/[sigh] inline tags. STT via the /v1/stt endpoint (single model, ~500 MB cap). Grok-2-image for image generation.',
    capabilities: ['chat', 'vision', 'tts', 'stt', 'image_gen'],
    signupUrl: 'https://console.x.ai',
    docsUrl: 'https://docs.x.ai',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    description:
      'Inference API across thousands of open models. Good for niche embeddings, specialty TTS voices, OCR, etc.',
    capabilities: ['chat', 'embedding', 'tts', 'stt', 'image_gen', 'vision'],
    signupUrl: 'https://huggingface.co/settings/tokens',
    docsUrl: 'https://huggingface.co/docs/api-inference',
    isAggregator: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek chat models direct. Strong reasoning at low cost.',
    capabilities: ['chat'],
    signupUrl: 'https://platform.deepseek.com',
    docsUrl: 'https://api-docs.deepseek.com',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    description:
      'Frontier models (GPT, Claude, Gemini, o-series) via one Copilot subscription. Reasoning-capable. API key = your GitHub Copilot OAuth token.',
    capabilities: ['chat'],
    signupUrl: 'https://github.com/settings/copilot',
    docsUrl: 'https://docs.github.com/en/copilot',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    description: 'Mistral chat and embeddings direct.',
    capabilities: ['chat', 'embedding'],
    signupUrl: 'https://console.mistral.ai',
    docsUrl: 'https://docs.mistral.ai',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    description: 'Cohere chat and high-quality embeddings.',
    capabilities: ['chat', 'embedding'],
    signupUrl: 'https://dashboard.cohere.com/api-keys',
    docsUrl: 'https://docs.cohere.com',
  },
  {
    id: 'deepgram',
    label: 'Deepgram',
    description:
      'Fast, accurate transcription. Cheaper than OpenAI Whisper and supports streaming if we wire that up later.',
    capabilities: ['stt'],
    signupUrl: 'https://console.deepgram.com',
    docsUrl: 'https://developers.deepgram.com',
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    description:
      'Premium TTS with a large voice library and voice cloning. Scribe v1 STT covers 99 languages with optional word-level timing.',
    capabilities: ['tts', 'stt'],
    signupUrl: 'https://elevenlabs.io/app/settings/api-keys',
    docsUrl: 'https://elevenlabs.io/docs',
  },
  {
    id: 'assemblyai',
    label: 'AssemblyAI',
    description:
      'Transcription with speaker diarization, sentiment, and topic detection.',
    capabilities: ['stt'],
    signupUrl: 'https://www.assemblyai.com/dashboard',
    docsUrl: 'https://www.assemblyai.com/docs',
  },
  {
    id: 'local',
    label: 'Local (self-hosted)',
    description:
      'A self-hosted OpenAI-compatible server (Ollama, LM Studio, llama.cpp, TEI, vLLM) on your own hardware — text never leaves your network. Chat base URL via MANTLE_LOCAL_CHAT_URL or a per-route base URL; embedding via MANTLE_LOCAL_EMBEDDING_URL. Both default to http://localhost:11434/v1.',
    capabilities: ['chat', 'embedding'],
    signupUrl: 'https://ollama.com/download',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
  },
] as const;

/** Look up a provider by id. Returns null for unknown ids (i.e. a
 *  free-text value the user typed before the catalog existed). */
export function getProvider(id: string): Provider | null {
  return (SUPPORTED_PROVIDERS as readonly Provider[]).find((p) => p.id === id) ?? null;
}

/** All providers that support the given capability, in catalog order.
 *  The worker form uses this to filter the provider dropdown — a TTS
 *  worker only sees TTS-capable providers, an STT worker only sees
 *  STT-capable ones. */
export function providersForCapability(cap: ProviderCapability): readonly Provider[] {
  return SUPPORTED_PROVIDERS.filter((p) => p.capabilities.includes(cap));
}

/** Type predicate so code can narrow `string` → `ProviderId` after
 *  pulling a value out of `api_keys.service` or `ai_workers.provider`. */
export function isProviderId(v: string): v is ProviderId {
  return (SUPPORTED_PROVIDERS as readonly Provider[]).some((p) => p.id === v);
}

/** Map of ai_workers.kind → required capability. Centralised so the
 *  provider filter in the UI stays in sync with the runtime dispatch
 *  expectations. Adding a new kind = add a row here. */
export const CAPABILITY_FOR_KIND: Record<string, ProviderCapability> = {
  reflector: 'chat',
  extractor: 'chat',
  summarizer: 'chat',
  tts: 'tts',
  stt: 'stt',
  vision: 'vision',
  // Documents reuse the vision capability — same providers/keys/models (the
  // multimodal chat models). Runtime routing differs (native PDF document
  // block vs image OCR), but provider eligibility is identical.
  document: 'vision',
  image_gen: 'image_gen',
  embedding: 'embedding',
  // Web search runs a chat-completion call against a Perplexity Sonar model on
  // OpenRouter, so it shares the 'chat' capability (provider eligibility).
  search: 'chat',
  search_advanced: 'chat',
  // The narrator runs a plain chat-completion to restyle a status line — same
  // 'chat' capability/provider eligibility as the other one-shot LLM workers.
  narrator: 'chat',
};
