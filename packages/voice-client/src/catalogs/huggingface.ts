/**
 * Hugging Face Inference Providers static catalog (chat models only).
 *
 * HF's API is fundamentally different from OpenAI's — it's a *router*
 * that proxies to many sub-providers (Cerebras, Groq, Together,
 * SambaNova, Fireworks, etc.) under one OpenAI-compatible endpoint
 * at `router.huggingface.co/v1/chat/completions`. You can append
 * routing-policy suffixes to the model id:
 *
 *   openai/gpt-oss-120b:fastest     ← default; HF picks lowest latency
 *   openai/gpt-oss-120b:cheapest    ← lowest cost-per-output-token
 *   openai/gpt-oss-120b:preferred   ← honour user's preference list
 *   openai/gpt-oss-120b:groq        ← pin to a specific provider
 *
 * The :fastest / :cheapest / :preferred / :<provider> suffix is
 * handled server-side — we just include or omit it on the model
 * string we pass to /v1/chat/completions. The adapter exposes a
 * `routing` knob on the worker params so operators can pick.
 *
 * The catalog below picks notable, broadly-available open-weight
 * models. HF lists thousands; we curate the ones worth defaulting to.
 * The `GET /v1/models` endpoint returns the live list with per-provider
 * pricing/throughput, so discovery fills in the rest.
 *
 * Capabilities: HF Inference Providers cover chat, vision (VLM),
 * embedding, text-to-image, text-to-video, and speech-to-text via
 * specialty endpoints, but ONLY the chat endpoint is OpenAI-compatible.
 * Non-chat tasks need custom call shapes — we ship chat now and add
 * other tasks as adapters when we want them.
 */

import type { ChatModelInfo, ImageGenModelInfo } from '../adapters/types';

export const HUGGINGFACE_BASE_URL = 'https://router.huggingface.co/v1';
/** Image-gen inference uses a separate, repo-id-based endpoint. The
 *  router doesn't proxy image tasks today — calls go straight to
 *  api-inference for the per-model URL. */
export const HUGGINGFACE_INFERENCE_BASE_URL = 'https://api-inference.huggingface.co';

/** Suffixes the HF router accepts on the model id. The adapter
 *  appends one of these to whatever model the user picks. */
export const HUGGINGFACE_ROUTING_POLICIES = ['fastest', 'cheapest', 'preferred'] as const;
export type HuggingfaceRoutingPolicy = (typeof HUGGINGFACE_ROUTING_POLICIES)[number];

/**
 * Curated list of notable open-weight chat models reliably available
 * through HF's router. Live `/v1/models` returns more — these are
 * useful defaults for the dropdown.
 */
export const HUGGINGFACE_CHAT_MODELS: readonly ChatModelInfo[] = [
  // ── OpenAI's open-weights releases ──────────────────────────────
  {
    id: 'openai/gpt-oss-120b',
    label: 'gpt-oss 120B (OpenAI open)',
    description: 'Large open-weights model from OpenAI. Solid general-purpose chat.',
    contextTokens: 128_000,
    capabilities: ['function_calling'],
  },
  {
    id: 'openai/gpt-oss-20b',
    label: 'gpt-oss 20B (OpenAI open)',
    description: 'Lighter open-weights model. Fast, cheaper, weaker reasoning.',
    contextTokens: 128_000,
    capabilities: ['function_calling'],
  },

  // ── DeepSeek (strong reasoning at low cost) ─────────────────────
  {
    id: 'deepseek-ai/DeepSeek-R1',
    label: 'DeepSeek R1',
    description: 'Open reasoning model. Strong on math/code; verbose chain-of-thought.',
    contextTokens: 64_000,
    capabilities: ['reasoning'],
  },
  {
    id: 'deepseek-ai/DeepSeek-V3',
    label: 'DeepSeek V3',
    description: 'General-purpose open chat. Cheap; solid coding ability.',
    contextTokens: 64_000,
    capabilities: ['function_calling'],
  },

  // ── Llama family (Meta open-weights) ────────────────────────────
  {
    id: 'meta-llama/Llama-3.3-70B-Instruct',
    label: 'Llama 3.3 70B Instruct',
    description: 'Latest open Llama instruction-tuned. Good balance of cost vs. quality.',
    contextTokens: 128_000,
    capabilities: ['function_calling'],
  },
  {
    id: 'meta-llama/Llama-3.2-11B-Vision-Instruct',
    label: 'Llama 3.2 11B Vision',
    description: 'Llama with image understanding. Whiteboard / receipt OCR candidate.',
    contextTokens: 128_000,
    capabilities: ['vision', 'function_calling'],
  },

  // ── Mistral open weights ────────────────────────────────────────
  {
    id: 'mistralai/Mistral-Large-Instruct-2411',
    label: 'Mistral Large',
    description: 'Mistral flagship open chat model.',
    contextTokens: 128_000,
    capabilities: ['function_calling'],
  },
  {
    id: 'mistralai/Mixtral-8x22B-Instruct-v0.1',
    label: 'Mixtral 8×22B Instruct',
    description: 'Mixture-of-experts. Strong multilingual; cheaper than dense large models.',
    contextTokens: 64_000,
    capabilities: ['function_calling'],
  },

  // ── Qwen (Alibaba — strong on code) ─────────────────────────────
  {
    id: 'Qwen/Qwen2.5-72B-Instruct',
    label: 'Qwen 2.5 72B',
    description: 'Strong general-purpose chat; particularly good at code.',
    contextTokens: 128_000,
    capabilities: ['function_calling'],
  },
  {
    id: 'Qwen/Qwen2.5-Coder-32B-Instruct',
    label: 'Qwen 2.5 Coder 32B',
    description: 'Code-specialist. Pair-programming / refactoring duty.',
    contextTokens: 128_000,
    capabilities: ['function_calling'],
  },
  {
    id: 'Qwen/Qwen2-VL-72B-Instruct',
    label: 'Qwen 2 VL 72B (vision)',
    description: 'Vision-language model. Image understanding plus chat.',
    contextTokens: 32_000,
    capabilities: ['vision'],
  },
];

// ─── Hugging Face image generation ───────────────────────────────────
//
// Endpoint: POST {HUGGINGFACE_INFERENCE_BASE_URL}/models/<repo>
// Auth:     Bearer
// Body:     { inputs: <prompt>, parameters: { negative_prompt, seed,
//             num_inference_steps, guidance_scale, width, height } }
// Response: raw image bytes (Content-Type image/png or image/jpeg).
//
// HF's catalogue is huge; we surface only the proven defaults so the
// dropdown isn't 200 items long. Operators can still type any repo id
// into the worker's `model` field for custom selections (the adapter
// passes it through verbatim).

export const HUGGINGFACE_IMAGE_MODELS: readonly ImageGenModelInfo[] = [
  {
    id: 'black-forest-labs/FLUX.1-dev',
    label: 'FLUX.1 dev',
    description:
      'Black Forest Labs FLUX.1 dev. Best open-source image quality today. Slower than Schnell.',
    tier: 'quality',
  },
  {
    id: 'black-forest-labs/FLUX.1-schnell',
    label: 'FLUX.1 schnell',
    description: 'Distilled FLUX. 4-step inference, 5-10x faster than dev. Slight quality drop.',
    tier: 'fast',
  },
  {
    id: 'stabilityai/stable-diffusion-xl-base-1.0',
    label: 'SDXL Base 1.0',
    description: 'Stability AI SDXL. Older baseline; widely supported by community LoRAs.',
    tier: 'balanced',
  },
  {
    id: 'stabilityai/stable-diffusion-3.5-large',
    label: 'Stable Diffusion 3.5 Large',
    description: 'Stability AI SD 3.5 Large. Higher quality than SDXL, more compute per image.',
    tier: 'quality',
  },
];

export const HUGGINGFACE_IMAGE_DEFAULT_MODEL = 'black-forest-labs/FLUX.1-schnell';
