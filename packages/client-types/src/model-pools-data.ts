/**
 * CURATED MODEL POOLS — the repo-shipped template.
 *
 * GENERATED from a live curation pass (the Curator specialist on the primary
 * brain, 2026-08-22, OpenRouter rankings/benchmarks evidence, prices captured
 * at curation time). Do NOT hand-edit entries here: curate at /models/pools
 * (by hand or via the Curator) and re-export with GET /api/model-pools/export.
 *
 * Seeded into `curated_models` for owners who have no curated entries yet
 * (fresh installs at onboarding; empty existing brains on upgrade). Owners who
 * have curated ANYTHING are never touched — their pools are their judgment.
 * Pricing snapshots ride along so direct-provider brains render the cost
 * comparison with no OpenRouter dependency.
 */

export type CuratedTemplateEntry = {
  pool: string;
  position: number;
  name: string;
  vendor: string | null;
  routes: { provider: string; model: string }[];
  pricing: {
    inputPerM: number | null;
    outputPerM: number | null;
    currency: 'USD';
    capturedAt: string;
    source: string;
  } | null;
  rating: number | null;
  note: string | null;
};

export const CURATED_MODEL_POOLS: readonly CuratedTemplateEntry[] = [
  {
    pool: 'agents',
    position: 0,
    name: 'Claude Opus 5',
    vendor: 'Anthropic',
    routes: [
      {
        provider: 'openrouter',
        model: 'anthropic/claude-opus-5',
      },
      {
        provider: 'anthropic',
        model: 'claude-opus-5',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 5,
      capturedAt: '2026-08-22T15:24:05.275Z',
      outputPerM: 25,
    },
    rating: 5,
    note: 'flagship: top agentic index (59.2) of any model checked, heavy real usage on OpenRouter',
  },
  {
    pool: 'agents',
    position: 1,
    name: 'Kimi K3',
    vendor: 'MoonshotAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k3',
      },
      {
        provider: 'moonshot',
        model: 'kimi-k3',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 3,
      capturedAt: '2026-08-22T15:24:05.299Z',
      outputPerM: 15,
    },
    rating: 4,
    note: 'strong coding (76.2) and agentic (54.3) scores, one of the heaviest-used models in real traffic',
  },
  {
    pool: 'agents',
    position: 2,
    name: 'GPT-5.6 Sol',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-sol',
      },
      {
        provider: 'openai',
        model: 'gpt-5.6-sol',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2,
      capturedAt: '2026-08-22T15:24:05.315Z',
      outputPerM: 10,
    },
    rating: 5,
    note: 'top coding index (77.4) among current models, strong agentic score (57.8), heavy real usage',
  },
  {
    pool: 'agents',
    position: 3,
    name: 'Claude Sonnet 5',
    vendor: 'Anthropic',
    routes: [
      {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-5',
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2,
      capturedAt: '2026-08-22T15:24:05.335Z',
      outputPerM: 10,
    },
    rating: 4,
    note: 'mid-tier workhorse, solid agentic/coding balance, one of the most-used tool-calling models on OpenRouter',
  },
  {
    pool: 'agents',
    position: 4,
    name: 'Grok 4.6',
    vendor: 'xAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'x-ai/grok-4.6',
      },
      {
        provider: 'xai',
        model: 'grok-4.6',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2,
      capturedAt: '2026-08-22T15:24:05.350Z',
      outputPerM: 6,
    },
    rating: 4,
    note: 'near-flagship agentic index (58.7) at half the output cost of the Opus/Sol tier, great price-to-capability ratio',
  },
  {
    pool: 'agents',
    position: 5,
    name: 'GLM-5.3',
    vendor: 'Z.ai',
    routes: [
      {
        provider: 'openrouter',
        model: 'z-ai/glm-5.3',
      },
      {
        provider: 'z-ai',
        model: 'glm-5.3',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 1.4,
      capturedAt: '2026-08-22T15:24:05.366Z',
      outputPerM: 4.4,
    },
    rating: 4,
    note: 'best value in the set: agentic index 59.1 (near the top) at a fraction of the flagship price',
  },
  {
    pool: 'agents',
    position: 6,
    name: 'DeepSeek V4 Pro 0813',
    vendor: 'DeepSeek',
    routes: [
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-pro-0813',
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro-0813',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 1.188,
      capturedAt: '2026-08-22T15:24:05.379Z',
      outputPerM: 3.564,
    },
    rating: 3,
    note: 'gets the job done: agentic 49.6 / coding 68.8 at a sub-$2 input price, credible cheap tool-use option',
  },
  {
    pool: 'agents',
    position: 7,
    name: 'Gemini 3.7 Flash',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3.7-flash',
      },
      {
        provider: 'google',
        model: 'gemini-3.7-flash',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.375,
      capturedAt: '2026-08-22T15:24:05.399Z',
      outputPerM: 1.875,
    },
    rating: 3,
    note: 'budget tier: 1M context, fast, agentic 45.1, cheap enough for high-volume tool-calling workloads',
  },
  {
    pool: 'agents',
    position: 8,
    name: 'DeepSeek V4 Flash 0731',
    vendor: 'DeepSeek',
    routes: [
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-flash-0731',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.08,
      capturedAt: '2026-08-22T15:24:05.419Z',
      outputPerM: 0.18,
    },
    rating: 3,
    note: 'near-free tier, agentic 48.4 despite the rock-bottom price, one of the top real-usage models on OpenRouter',
  },
  {
    pool: 'agents',
    position: 9,
    name: 'Nemotron 3 Ultra (free)',
    vendor: 'NVIDIA',
    routes: [
      {
        provider: 'openrouter',
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0,
      capturedAt: '2026-08-22T15:24:05.433Z',
      outputPerM: 0,
    },
    rating: 2,
    note: 'FREE tier: 1M context, one of the highest-volume free models on OpenRouter, but rate-limited and no vendor SLA, use as a fallback not a default',
  },
  {
    pool: 'document',
    position: 0,
    name: 'Claude Opus 5',
    vendor: 'Anthropic',
    routes: [
      {
        provider: 'openrouter',
        model: 'anthropic/claude-opus-5',
      },
      {
        provider: 'anthropic',
        model: 'claude-opus-5',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 5,
      capturedAt: '2026-08-22T15:31:39.396Z',
      outputPerM: 25,
    },
    rating: 5,
    note: 'flagship: top intelligence index (63.1), 1M context, best for compliance-grade / high-stakes document reasoning',
  },
  {
    pool: 'document',
    position: 1,
    name: 'GPT-5.6 Terra Pro',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-terra-pro',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2,
      capturedAt: '2026-08-22T15:31:39.408Z',
      outputPerM: 12,
    },
    rating: 5,
    note: 'flagship-tier, 1.05M context native file input; OpenRouter-only codename, unsure of a direct OpenAI slug',
  },
  {
    pool: 'document',
    position: 2,
    name: 'Gemini 3.1 Pro Preview',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3.1-pro-preview',
      },
      {
        provider: 'google',
        model: 'gemini-3.1-pro-preview',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2,
      capturedAt: '2026-08-22T15:31:39.417Z',
      outputPerM: 12,
    },
    rating: 5,
    note: 'flagship deep-research tier, 1M context, strong long-document analysis',
  },
  {
    pool: 'document',
    position: 3,
    name: 'Claude Sonnet 5',
    vendor: 'Anthropic',
    routes: [
      {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-5',
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2,
      capturedAt: '2026-08-22T15:31:39.432Z',
      outputPerM: 10,
    },
    rating: 4,
    note: 'balanced flagship, heaviest real-world usage of the Claude line (2.1T tokens/14d, rank #7 overall)',
  },
  {
    pool: 'document',
    position: 4,
    name: 'Gemini 3.7 Flash',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3.7-flash',
      },
      {
        provider: 'google',
        model: 'gemini-3.7-flash',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.375,
      capturedAt: '2026-08-22T15:31:39.448Z',
      outputPerM: 1.875,
    },
    rating: 4,
    note: 'value tier: 1M context for cents, high real usage, gets long documents ingested cheaply',
  },
  {
    pool: 'document',
    position: 5,
    name: 'GPT-5.6 Luna Pro',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-luna-pro',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.2,
      capturedAt: '2026-08-22T15:31:39.460Z',
      outputPerM: 1.2,
    },
    rating: 3,
    note: 'budget workhorse, 1.05M context; #2 by raw token volume across all of OpenRouter, so heavily trusted for bulk document jobs',
  },
  {
    pool: 'document',
    position: 6,
    name: 'Dots3-Note Preview (free)',
    vendor: 'Dots Studio',
    routes: [
      {
        provider: 'openrouter',
        model: 'dots-studio/dots-3-note-preview:free',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0,
      capturedAt: '2026-08-22T15:31:39.483Z',
      outputPerM: 0,
    },
    rating: 2,
    note: 'FREE, 512K context; reads text+image only (no native PDF/file mime, rasterize first), rate-limited',
  },
  {
    pool: 'extractor',
    position: 0,
    name: 'DeepSeek V4 Pro 0813',
    vendor: 'DeepSeek',
    routes: [
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-pro-0813',
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro-0813',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 1.188,
      capturedAt: '2026-08-22T15:26:00.323Z',
      outputPerM: 3.564,
    },
    rating: 4,
    note: 'priciest of the set: reasoning-capable, most reliable for structured JSON/entity extraction',
  },
  {
    pool: 'extractor',
    position: 1,
    name: 'Gemini 2.5 Flash',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash',
      },
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.3,
      capturedAt: '2026-08-22T15:26:00.355Z',
      outputPerM: 2.5,
    },
    rating: 4,
    note: 'strong structured multimodal extraction, heavy real usage in customer-support/classification traffic',
  },
  {
    pool: 'extractor',
    position: 2,
    name: 'Gemini 3.7 Flash',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3.7-flash',
      },
      {
        provider: 'google',
        model: 'gemini-3.7-flash',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.375,
      capturedAt: '2026-08-22T15:26:00.380Z',
      outputPerM: 1.875,
    },
    rating: 4,
    note: '1M context, handles long documents without truncation, solid extraction accuracy',
  },
  {
    pool: 'extractor',
    position: 3,
    name: 'GPT-5.6 Luna',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-luna',
      },
      {
        provider: 'openai',
        model: 'gpt-5.6-luna',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.2,
      capturedAt: '2026-08-22T15:26:00.416Z',
      outputPerM: 1.2,
    },
    rating: 4,
    note: '#1 by usage share in the data-transformation task class, reliable structured output at scale',
  },
  {
    pool: 'extractor',
    position: 4,
    name: 'GPT-4o-mini',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
      },
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.15,
      capturedAt: '2026-08-22T15:26:00.436Z',
      outputPerM: 0.6,
    },
    rating: 3,
    note: 'older generation but steady usage share across classification/extraction, safe legacy fallback',
  },
  {
    pool: 'extractor',
    position: 5,
    name: 'Gemini 2.5 Flash Lite',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-lite',
      },
      {
        provider: 'google',
        model: 'gemini-2.5-flash-lite',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.1,
      capturedAt: '2026-08-22T15:26:00.450Z',
      outputPerM: 0.4,
    },
    rating: 4,
    note: '#1 by usage share in BOTH the classification and data-extraction task classes: the default-grade extractor',
  },
  {
    pool: 'extractor',
    position: 6,
    name: 'DeepSeek V4 Flash 0731',
    vendor: 'DeepSeek',
    routes: [
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-flash-0731',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.08,
      capturedAt: '2026-08-22T15:26:00.469Z',
      outputPerM: 0.18,
    },
    rating: 4,
    note: 'top real usage in the memory-extraction task class specifically, excellent price for reliability delivered',
  },
  {
    pool: 'extractor',
    position: 7,
    name: 'GPT-OSS 120B',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-oss-120b',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.03,
      capturedAt: '2026-08-22T15:26:00.494Z',
      outputPerM: 0.17,
    },
    rating: 3,
    note: 'open-weight, near-free, credible extraction/classification traffic share',
  },
  {
    pool: 'extractor',
    position: 8,
    name: 'Mistral Nemo',
    vendor: 'Mistral',
    routes: [
      {
        provider: 'openrouter',
        model: 'mistralai/mistral-nemo',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.019,
      capturedAt: '2026-08-22T15:26:00.513Z',
      outputPerM: 0.03,
    },
    rating: 3,
    note: 'near-free, notable extraction traffic share, but only 131K context: short documents only',
  },
  {
    pool: 'extractor',
    position: 9,
    name: 'Nemotron 3 Ultra (free)',
    vendor: 'NVIDIA',
    routes: [
      {
        provider: 'openrouter',
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0,
      capturedAt: '2026-08-22T15:26:00.530Z',
      outputPerM: 0,
    },
    rating: 2,
    note: 'FREE: rate-limited, no vendor SLA; keep as bottom fallback, not the default extractor',
  },
  {
    pool: 'image_gen',
    position: 0,
    name: 'GPT-5.4 Image 2',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-5.4-image-2',
      },
      {
        provider: 'openai',
        model: 'gpt-5.4-image-2',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 8,
      capturedAt: '2026-08-22T15:35:35.085Z',
      outputPerM: 15,
    },
    rating: 5,
    note: 'flagship, priciest image model in catalog; #6 by real image_output usage (OpenRouter, 14-day window)',
  },
  {
    pool: 'image_gen',
    position: 1,
    name: 'Nano Banana Pro (Gemini 3 Pro Image)',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3-pro-image',
      },
      {
        provider: 'google',
        model: 'gemini-3-pro-image',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2,
      capturedAt: '2026-08-22T15:35:35.102Z',
      outputPerM: 12,
    },
    rating: 5,
    note: "Google's flagship image model; strong prompt fidelity, #8 by real usage",
  },
  {
    pool: 'image_gen',
    position: 2,
    name: 'Nano Banana 2 (Gemini 3.1 Flash Image)',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3.1-flash-image',
      },
      {
        provider: 'google',
        model: 'gemini-3.1-flash-image',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.5,
      capturedAt: '2026-08-22T15:35:35.116Z',
      outputPerM: 3,
    },
    rating: 4,
    note: 'workhorse tier, #2 by real image_output usage of any model on OpenRouter',
  },
  {
    pool: 'image_gen',
    position: 3,
    name: 'Nano Banana (Gemini 2.5 Flash Image)',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-image',
      },
      {
        provider: 'google',
        model: 'gemini-2.5-flash-image',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.3,
      capturedAt: '2026-08-22T15:35:35.132Z',
      outputPerM: 2.5,
    },
    rating: 4,
    note: 'older gen but #1 by real image_output usage on OpenRouter, gets the job done cheaply',
  },
  {
    pool: 'image_gen',
    position: 4,
    name: 'Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3.1-flash-lite-image',
      },
      {
        provider: 'google',
        model: 'gemini-3.1-flash-lite-image',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.25,
      capturedAt: '2026-08-22T15:35:35.143Z',
      outputPerM: 1.5,
    },
    rating: 3,
    note: 'cheapest catalog entry, #5 by real usage; budget tier, smaller 65K context',
  },
  {
    pool: 'image_gen',
    position: 5,
    name: 'DALL-E 3',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openai',
        model: 'dall-e-3',
      },
    ],
    pricing: null,
    rating: 3,
    note: "direct-only: not listed in OpenRouter's catalog under this pass, pricing gap, use OpenAI's own API/pricing page. No credible $0 image-output model found on OpenRouter this pass",
  },
  {
    pool: 'narrator',
    position: 0,
    name: 'DeepSeek V4 Pro 0813',
    vendor: 'DeepSeek',
    routes: [
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-pro-0813',
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro-0813',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 1.188,
      capturedAt: '2026-08-22T15:28:36.933Z',
      outputPerM: 3.564,
    },
    rating: 4,
    note: 'priciest of the set; overkill for narration duty but there if a run needs careful phrasing',
  },
  {
    pool: 'narrator',
    position: 1,
    name: 'Gemini 2.5 Flash',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash',
      },
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.3,
      capturedAt: '2026-08-22T15:28:36.948Z',
      outputPerM: 2.5,
    },
    rating: 4,
    note: 'solid, natural-sounding prose for run narration; heavy real-world usage',
  },
  {
    pool: 'narrator',
    position: 2,
    name: 'Gemini 3.7 Flash',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3.7-flash',
      },
      {
        provider: 'google',
        model: 'gemini-3.7-flash',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.375,
      capturedAt: '2026-08-22T15:28:36.961Z',
      outputPerM: 1.875,
    },
    rating: 4,
    note: '1M context, useful if narrating a run with a very long tool-output trail',
  },
  {
    pool: 'narrator',
    position: 3,
    name: 'GPT-5.6 Luna',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-luna',
      },
      {
        provider: 'openai',
        model: 'gpt-5.6-luna',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.2,
      capturedAt: '2026-08-22T15:28:36.976Z',
      outputPerM: 1.2,
    },
    rating: 4,
    note: 'reliable, even tone for status lines; high-volume usage share elsewhere in the stack',
  },
  {
    pool: 'narrator',
    position: 4,
    name: 'GPT-4o-mini',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
      },
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.15,
      capturedAt: '2026-08-22T15:28:36.992Z',
      outputPerM: 0.6,
    },
    rating: 3,
    note: 'older generation but dependable plain-English narration, safe legacy fallback',
  },
  {
    pool: 'narrator',
    position: 5,
    name: 'Gemini 2.5 Flash Lite',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-lite',
      },
      {
        provider: 'google',
        model: 'gemini-2.5-flash-lite',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.1,
      capturedAt: '2026-08-22T15:28:37.007Z',
      outputPerM: 0.4,
    },
    rating: 4,
    note: 'default pick for narration: cheap, quick, reads naturally for one-liners off the critical path',
  },
  {
    pool: 'narrator',
    position: 6,
    name: 'DeepSeek V4 Flash 0731',
    vendor: 'DeepSeek',
    routes: [
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-flash-0731',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.08,
      capturedAt: '2026-08-22T15:28:37.022Z',
      outputPerM: 0.18,
    },
    rating: 4,
    note: 'very cheap, still coherent short-prose narration; good high-volume choice',
  },
  {
    pool: 'narrator',
    position: 7,
    name: 'GPT-OSS 120B',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-oss-120b',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.03,
      capturedAt: '2026-08-22T15:28:37.036Z',
      outputPerM: 0.17,
    },
    rating: 3,
    note: "open-weight, near-free; fine for terse tool-outcome lines where flourish doesn't matter",
  },
  {
    pool: 'narrator',
    position: 8,
    name: 'Mistral Nemo',
    vendor: 'Mistral',
    routes: [
      {
        provider: 'openrouter',
        model: 'mistralai/mistral-nemo',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.019,
      capturedAt: '2026-08-22T15:28:37.051Z',
      outputPerM: 0.03,
    },
    rating: 3,
    note: 'near-free, fine for a single narrated sentence; 131K context is plenty for this job',
  },
  {
    pool: 'narrator',
    position: 9,
    name: 'Nemotron 3 Ultra (free)',
    vendor: 'NVIDIA',
    routes: [
      {
        provider: 'openrouter',
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0,
      capturedAt: '2026-08-22T15:28:37.066Z',
      outputPerM: 0,
    },
    rating: 2,
    note: 'FREE: rate-limited, no SLA; fine as a bottom-tier narrator for low-stakes, off-critical-path lines only',
  },
  {
    pool: 'reflector',
    position: 0,
    name: 'DeepSeek V4 Pro 0813',
    vendor: 'DeepSeek',
    routes: [
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-pro-0813',
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro-0813',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 1.188,
      capturedAt: '2026-08-22T15:27:45.244Z',
      outputPerM: 3.564,
    },
    rating: 5,
    note: 'flagship reasoning, use when reflection needs real depth',
  },
  {
    pool: 'reflector',
    position: 1,
    name: 'Gemini 3.7 Flash',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3.7-flash',
      },
      {
        provider: 'google',
        model: 'gemini-3.7-flash',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.375,
      capturedAt: '2026-08-22T15:27:45.260Z',
      outputPerM: 1.875,
    },
    rating: 4,
    note: 'strong current-gen reflection quality, moderate cost',
  },
  {
    pool: 'reflector',
    position: 2,
    name: 'Gemini 2.5 Flash',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash',
      },
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.3,
      capturedAt: '2026-08-22T15:27:45.275Z',
      outputPerM: 2.5,
    },
    rating: 4,
    note: 'reliable workhorse, good at teasing patterns out of journal-style text',
  },
  {
    pool: 'reflector',
    position: 3,
    name: 'GPT-5.6 Luna',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-luna',
      },
      {
        provider: 'openai',
        model: 'gpt-5.6-luna',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.2,
      capturedAt: '2026-08-22T15:27:45.290Z',
      outputPerM: 1.2,
    },
    rating: 4,
    note: 'gets the job done, decent tone for reflective/introspective writing',
  },
  {
    pool: 'reflector',
    position: 4,
    name: 'GPT-4o-mini',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
      },
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.15,
      capturedAt: '2026-08-22T15:27:45.308Z',
      outputPerM: 0.6,
    },
    rating: 3,
    note: 'gets the job done, safe default for routine reflection passes',
  },
  {
    pool: 'reflector',
    position: 5,
    name: 'Gemini 2.5 Flash Lite',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-lite',
      },
      {
        provider: 'google',
        model: 'gemini-2.5-flash-lite',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.1,
      capturedAt: '2026-08-22T15:27:45.321Z',
      outputPerM: 0.4,
    },
    rating: 3,
    note: 'cheap and fast, fine for short reflective summaries',
  },
  {
    pool: 'reflector',
    position: 6,
    name: 'DeepSeek V4 Flash 0731',
    vendor: 'DeepSeek',
    routes: [
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-flash-0731',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.08,
      capturedAt: '2026-08-22T15:27:45.334Z',
      outputPerM: 0.18,
    },
    rating: 3,
    note: 'budget workhorse, solid enough for pattern-noticing on personal notes',
  },
  {
    pool: 'reflector',
    position: 7,
    name: 'GPT-OSS 120B',
    vendor: 'OpenAI (open-weight)',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-oss-120b',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.03,
      capturedAt: '2026-08-22T15:27:45.345Z',
      outputPerM: 0.17,
    },
    rating: 3,
    note: 'open-weight, very cheap, adequate for low-stakes reflection drafts',
  },
  {
    pool: 'reflector',
    position: 8,
    name: 'Mistral Nemo',
    vendor: 'Mistral',
    routes: [
      {
        provider: 'openrouter',
        model: 'mistralai/mistral-nemo',
      },
      {
        provider: 'mistral',
        model: 'mistral-nemo',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.019,
      capturedAt: '2026-08-22T15:27:45.360Z',
      outputPerM: 0.03,
    },
    rating: 2,
    note: 'near-free, use for lightweight reflection where nuance matters less than cost',
  },
  {
    pool: 'reflector',
    position: 9,
    name: 'Nemotron 3 Ultra',
    vendor: 'Nvidia',
    routes: [
      {
        provider: 'openrouter',
        model: 'nvidia/nemotron-3-ultra:free',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0,
      capturedAt: '2026-08-22T15:27:45.387Z',
      outputPerM: 0,
    },
    rating: 2,
    note: 'FREE tier: rate-limited, fine as an overflow/fallback reflector, not for anything time-sensitive',
  },
  {
    pool: 'search',
    position: 0,
    name: 'Sonar Pro',
    vendor: 'Perplexity',
    routes: [
      {
        provider: 'openrouter',
        model: 'perplexity/sonar-pro',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 3,
      capturedAt: '2026-08-22T15:33:46.750Z',
      outputPerM: 15,
    },
    rating: 4,
    note: 'standard search-native workhorse: 200K context, built-in citations, the default web-answer tier',
  },
  {
    pool: 'search',
    position: 1,
    name: 'Sonar',
    vendor: 'Perplexity',
    routes: [
      {
        provider: 'openrouter',
        model: 'perplexity/sonar',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 1,
      capturedAt: '2026-08-22T15:33:46.766Z',
      outputPerM: 1,
    },
    rating: 3,
    note: 'budget tier: cheapest search-native Sonar, flat $1/$1 pricing, gets simple lookups done',
  },
  {
    pool: 'search_advanced',
    position: 0,
    name: 'Sonar Deep Research',
    vendor: 'Perplexity',
    routes: [
      {
        provider: 'openrouter',
        model: 'perplexity/sonar-deep-research',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2,
      capturedAt: '2026-08-22T15:33:46.784Z',
      outputPerM: 8,
    },
    rating: 5,
    note: 'flagship deep-search tier: multi-step research passes for hard or conflicting questions',
  },
  {
    pool: 'search_advanced',
    position: 1,
    name: 'Sonar Reasoning Pro',
    vendor: 'Perplexity',
    routes: [
      {
        provider: 'openrouter',
        model: 'perplexity/sonar-reasoning-pro',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2,
      capturedAt: '2026-08-22T15:33:46.801Z',
      outputPerM: 8,
    },
    rating: 4,
    note: 'reasoning-heavy search tier at the same price as deep research, good second option when you want chain-of-thought over the sources rather than a long research pass',
  },
  {
    pool: 'stt',
    position: 0,
    name: 'GPT Audio',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-audio',
      },
      {
        provider: 'openai',
        model: 'gpt-audio',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2.5,
      capturedAt: '2026-08-22T15:33:46.694Z',
      outputPerM: 10,
    },
    rating: 5,
    note: 'flagship: reasons over the audio while transcribing, best for noisy or ambiguous voice notes; overkill for plain dictation',
  },
  {
    pool: 'stt',
    position: 1,
    name: 'GPT-4o Transcribe',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openai',
        model: 'gpt-4o-transcribe',
      },
    ],
    pricing: null,
    rating: 4,
    note: "not in OpenRouter's catalog (dedicated /audio/transcriptions endpoint); current-gen replacement for Whisper, confirm live price on OpenAI's pricing page",
  },
  {
    pool: 'stt',
    position: 2,
    name: 'Whisper-1',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openai',
        model: 'whisper-1',
      },
    ],
    pricing: null,
    rating: 3,
    note: "not in OpenRouter's catalog; the long-standing default transcription model, wide language coverage, also runnable self-hosted from the open weights if you want zero per-token cost",
  },
  {
    pool: 'stt',
    position: 3,
    name: 'GPT-4o Mini Transcribe',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openai',
        model: 'gpt-4o-mini-transcribe',
      },
    ],
    pricing: null,
    rating: 3,
    note: "not in OpenRouter's catalog; budget dedicated transcription tier, gets the job done for short voice notes",
  },
  {
    pool: 'suggester',
    position: 0,
    name: 'DeepSeek V4 Pro 0813',
    vendor: 'DeepSeek',
    routes: [
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-pro-0813',
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro-0813',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 1.188,
      capturedAt: '2026-08-22T15:29:39.530Z',
      outputPerM: 3.564,
    },
    rating: 4,
    note: 'flagship reasoning, but overkill for a few follow-up chips: parked at the top only as a ceiling reference',
  },
  {
    pool: 'suggester',
    position: 1,
    name: 'Gemini 3.7 Flash',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3.7-flash',
      },
      {
        provider: 'google',
        model: 'gemini-3.7-flash',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.375,
      capturedAt: '2026-08-22T15:29:39.549Z',
      outputPerM: 1.875,
    },
    rating: 4,
    note: 'current-gen Flash, fast enough for chips but priced above what a suggestion chip needs',
  },
  {
    pool: 'suggester',
    position: 2,
    name: 'Gemini 2.5 Flash',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash',
      },
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.3,
      capturedAt: '2026-08-22T15:29:39.562Z',
      outputPerM: 2.5,
    },
    rating: 4,
    note: 'previous-gen Flash, still solid but the output price is heavy for a one-line chip job',
  },
  {
    pool: 'suggester',
    position: 3,
    name: 'GPT-5.6 Luna',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-luna',
      },
      {
        provider: 'openai',
        model: 'gpt-5.6-luna',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.2,
      capturedAt: '2026-08-22T15:29:39.573Z',
      outputPerM: 1.2,
    },
    rating: 4,
    note: 'gets the job done, reasonable middle-of-pack cost for short chip generations',
  },
  {
    pool: 'suggester',
    position: 4,
    name: 'GPT-4o-mini',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
      },
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.15,
      capturedAt: '2026-08-22T15:29:39.591Z',
      outputPerM: 0.6,
    },
    rating: 3,
    note: 'older but cheap and dependable, fine for short suggestion-chip text',
  },
  {
    pool: 'suggester',
    position: 5,
    name: 'Gemini 2.5 Flash Lite',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-lite',
      },
      {
        provider: 'google',
        model: 'gemini-2.5-flash-lite',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.1,
      capturedAt: '2026-08-22T15:29:39.608Z',
      outputPerM: 0.4,
    },
    rating: 3,
    note: 'right-sized for chips: cheap, fast, big context if a long thread needs skimming',
  },
  {
    pool: 'suggester',
    position: 6,
    name: 'DeepSeek V4 Flash 0731',
    vendor: 'DeepSeek',
    routes: [
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-flash-0731',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.08,
      capturedAt: '2026-08-22T15:29:39.620Z',
      outputPerM: 0.18,
    },
    rating: 3,
    note: 'near-bottom pricing with a full 1M+ context, a strong budget default for chip generation',
  },
  {
    pool: 'suggester',
    position: 7,
    name: 'GPT-OSS 120B',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-oss-120b',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.03,
      capturedAt: '2026-08-22T15:29:39.640Z',
      outputPerM: 0.17,
    },
    rating: 3,
    note: 'open-weights, pennies per chip batch, plenty capable for a short suggestion line',
  },
  {
    pool: 'suggester',
    position: 8,
    name: 'Mistral Nemo',
    vendor: 'Mistral',
    routes: [
      {
        provider: 'openrouter',
        model: 'mistralai/mistral-nemo',
      },
      {
        provider: 'mistral',
        model: 'mistral-nemo',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.019,
      capturedAt: '2026-08-22T15:29:39.654Z',
      outputPerM: 0.03,
    },
    rating: 2,
    note: 'the natural fit here: this job is exactly what a cheap small model was built for, near-zero cost per chip',
  },
  {
    pool: 'suggester',
    position: 9,
    name: 'Nemotron 3 Ultra (free)',
    vendor: 'NVIDIA',
    routes: [
      {
        provider: 'openrouter',
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0,
      capturedAt: '2026-08-22T15:29:39.665Z',
      outputPerM: 0,
    },
    rating: 2,
    note: 'FREE tier, rate-limited: the other natural fit for a throwaway chip job, use as fallback when quota allows',
  },
  {
    pool: 'summarizer',
    position: 0,
    name: 'DeepSeek V4 Pro 0813',
    vendor: 'DeepSeek',
    routes: [
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-pro-0813',
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-pro-0813',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 1.188,
      capturedAt: '2026-08-22T15:26:23.080Z',
      outputPerM: 3.564,
    },
    rating: 4,
    note: 'priciest of the set: reasoning-capable, best for summaries that need careful synthesis',
  },
  {
    pool: 'summarizer',
    position: 1,
    name: 'Gemini 2.5 Flash',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash',
      },
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.3,
      capturedAt: '2026-08-22T15:26:23.109Z',
      outputPerM: 2.5,
    },
    rating: 4,
    note: 'strong multimodal workhorse, heavy real usage in customer-support/classification traffic',
  },
  {
    pool: 'summarizer',
    position: 2,
    name: 'Gemini 3.7 Flash',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3.7-flash',
      },
      {
        provider: 'google',
        model: 'gemini-3.7-flash',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.375,
      capturedAt: '2026-08-22T15:26:23.122Z',
      outputPerM: 1.875,
    },
    rating: 4,
    note: '1M context, condenses long documents in one pass without truncation',
  },
  {
    pool: 'summarizer',
    position: 3,
    name: 'GPT-5.6 Luna',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-luna',
      },
      {
        provider: 'openai',
        model: 'gpt-5.6-luna',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.2,
      capturedAt: '2026-08-22T15:26:23.137Z',
      outputPerM: 1.2,
    },
    rating: 4,
    note: '#1 by usage share in the data-transformation task class, reliable at high volume',
  },
  {
    pool: 'summarizer',
    position: 4,
    name: 'GPT-4o-mini',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
      },
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.15,
      capturedAt: '2026-08-22T15:26:23.157Z',
      outputPerM: 0.6,
    },
    rating: 3,
    note: 'older generation but steady usage share for summaries, safe legacy fallback',
  },
  {
    pool: 'summarizer',
    position: 5,
    name: 'Gemini 2.5 Flash Lite',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-lite',
      },
      {
        provider: 'google',
        model: 'gemini-2.5-flash-lite',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.1,
      capturedAt: '2026-08-22T15:26:23.176Z',
      outputPerM: 0.4,
    },
    rating: 4,
    note: '#1 by usage share in classification, heavy volume, cheap general-purpose condenser',
  },
  {
    pool: 'summarizer',
    position: 6,
    name: 'DeepSeek V4 Flash 0731',
    vendor: 'DeepSeek',
    routes: [
      {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
      },
      {
        provider: 'deepseek',
        model: 'deepseek-v4-flash-0731',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.08,
      capturedAt: '2026-08-22T15:26:23.200Z',
      outputPerM: 0.18,
    },
    rating: 4,
    note: 'top model by usage share directly in the summarization task class, excellent price for reliability delivered',
  },
  {
    pool: 'summarizer',
    position: 7,
    name: 'GPT-OSS 120B',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-oss-120b',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.03,
      capturedAt: '2026-08-22T15:26:23.213Z',
      outputPerM: 0.17,
    },
    rating: 3,
    note: 'open-weight, near-free, real share of the summarization task class',
  },
  {
    pool: 'summarizer',
    position: 8,
    name: 'Mistral Nemo',
    vendor: 'Mistral',
    routes: [
      {
        provider: 'openrouter',
        model: 'mistralai/mistral-nemo',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.019,
      capturedAt: '2026-08-22T15:26:23.225Z',
      outputPerM: 0.03,
    },
    rating: 3,
    note: 'near-free, real summarization traffic share, but only 131K context: short inputs only',
  },
  {
    pool: 'summarizer',
    position: 9,
    name: 'Nemotron 3 Ultra (free)',
    vendor: 'NVIDIA',
    routes: [
      {
        provider: 'openrouter',
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0,
      capturedAt: '2026-08-22T15:26:23.236Z',
      outputPerM: 0,
    },
    rating: 2,
    note: 'FREE: rate-limited, no vendor SLA; keep as bottom fallback, not the default summarizer',
  },
  {
    pool: 'tts',
    position: 0,
    name: 'GPT Audio',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-audio',
      },
      {
        provider: 'openai',
        model: 'gpt-audio',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2.5,
      capturedAt: '2026-08-22T15:33:46.617Z',
      outputPerM: 10,
    },
    rating: 5,
    note: 'flagship: native audio-in/audio-out chat model, best for expressive replies with reasoning behind the voice',
  },
  {
    pool: 'tts',
    position: 1,
    name: 'ElevenLabs Multilingual v2',
    vendor: 'ElevenLabs',
    routes: [
      {
        provider: 'elevenlabs',
        model: 'eleven_multilingual_v2',
      },
    ],
    pricing: null,
    rating: 5,
    note: "not in OpenRouter's catalog (direct provider endpoint, billed per character not per token); industry-standard voice quality, verify current price on ElevenLabs' own pricing page before adopting",
  },
  {
    pool: 'tts',
    position: 2,
    name: 'GPT Audio Mini',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openrouter',
        model: 'openai/gpt-audio-mini',
      },
      {
        provider: 'openai',
        model: 'gpt-audio-mini',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.6,
      capturedAt: '2026-08-22T15:33:46.649Z',
      outputPerM: 2.4,
    },
    rating: 4,
    note: 'gets the job done: same audio-in/out shape as GPT Audio at a quarter the price',
  },
  {
    pool: 'tts',
    position: 3,
    name: 'GPT-4o Mini TTS',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openai',
        model: 'gpt-4o-mini-tts',
      },
    ],
    pricing: null,
    rating: 3,
    note: "not in OpenRouter's catalog (dedicated /audio/speech endpoint, not a chat model); OpenAI's cheap steerable-voice TTS tier, confirm live price on OpenAI's pricing page",
  },
  {
    pool: 'tts',
    position: 4,
    name: 'TTS-1',
    vendor: 'OpenAI',
    routes: [
      {
        provider: 'openai',
        model: 'tts-1',
      },
    ],
    pricing: null,
    rating: 2,
    note: "not in OpenRouter's catalog (legacy dedicated TTS endpoint); cheapest OpenAI voice tier, fine for plain status-line speech, lower expressiveness than newer audio models",
  },
  {
    pool: 'vision',
    position: 0,
    name: 'Claude Opus 5',
    vendor: 'Anthropic',
    routes: [
      {
        provider: 'openrouter',
        model: 'anthropic/claude-opus-5',
      },
      {
        provider: 'anthropic',
        model: 'claude-opus-5',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 5,
      capturedAt: '2026-08-22T15:31:39.502Z',
      outputPerM: 25,
    },
    rating: 5,
    note: 'flagship: best reasoning-over-image quality (charts, handwriting, messy scans), top intelligence index',
  },
  {
    pool: 'vision',
    position: 1,
    name: 'Gemini 3 Pro Image (Nano Banana Pro)',
    vendor: 'Google',
    routes: [
      {
        provider: 'openrouter',
        model: 'google/gemini-3-pro-image',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2,
      capturedAt: '2026-08-22T15:31:39.522Z',
      outputPerM: 12,
    },
    rating: 5,
    note: 'purpose-built image model, flagship OCR/extraction quality, can also edit/generate images; 131K context',
  },
  {
    pool: 'vision',
    position: 2,
    name: 'Claude Sonnet 5',
    vendor: 'Anthropic',
    routes: [
      {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-5',
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 2,
      capturedAt: '2026-08-22T15:31:39.541Z',
      outputPerM: 10,
    },
    rating: 4,
    note: 'balanced flagship vision, heavy real-world usage, reliable for photos and screenshots',
  },
  {
    pool: 'vision',
    position: 3,
    name: 'Qwen3 VL 235B A22B Instruct',
    vendor: 'Alibaba/Qwen',
    routes: [
      {
        provider: 'openrouter',
        model: 'qwen/qwen3-vl-235b-a22b-instruct',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.21,
      capturedAt: '2026-08-22T15:31:39.551Z',
      outputPerM: 1.9,
    },
    rating: 4,
    note: 'dedicated open vision-language flagship, strong OCR/document-image benchmarks at a fraction of frontier price; 262K context',
  },
  {
    pool: 'vision',
    position: 4,
    name: 'Qwen3 VL 30B A3B Instruct',
    vendor: 'Alibaba/Qwen',
    routes: [
      {
        provider: 'openrouter',
        model: 'qwen/qwen3-vl-30b-a3b-instruct',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0.13,
      capturedAt: '2026-08-22T15:31:46.998Z',
      outputPerM: 0.52,
    },
    rating: 3,
    note: 'budget dedicated VL model, gets the job done on routine OCR/extraction; 262K context',
  },
  {
    pool: 'vision',
    position: 5,
    name: 'Nemotron Nano 12B V2 VL (free)',
    vendor: 'NVIDIA',
    routes: [
      {
        provider: 'openrouter',
        model: 'nvidia/nemotron-nano-12b-v2-vl:free',
      },
    ],
    pricing: {
      source: 'openrouter',
      currency: 'USD',
      inputPerM: 0,
      capturedAt: '2026-08-22T15:31:47.019Z',
      outputPerM: 0,
    },
    rating: 2,
    note: 'FREE, 128K context, real vision-language model (not just text); rate-limited, best for low-stakes/high-volume extraction',
  },
];
