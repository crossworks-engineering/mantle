/**
 * Hugging Face Inference Providers chat adapter.
 *
 * HF's router exposes an OpenAI-compatible chat completions endpoint
 * at `https://router.huggingface.co/v1/chat/completions`. Under the
 * hood it dispatches to many sub-providers (Cerebras, Groq, Together,
 * SambaNova, Fireworks, etc.) and you steer the choice via a suffix
 * on the model id:
 *
 *   `<owner>/<model>:fastest`    ← lowest latency provider (default)
 *   `<owner>/<model>:cheapest`   ← lowest cost per output token
 *   `<owner>/<model>:preferred`  ← honour your preference order
 *   `<owner>/<model>:<provider>` ← pin to a specific sub-provider
 *
 * We pass through whatever the user types, and we expose the suffix
 * options in the worker form via params.huggingface_routing.
 *
 * Discovery: GET /v1/models is documented to return the live list
 * across all sub-providers with per-provider pricing/throughput. We
 * intersect with the static curated catalog so the dropdown stays
 * focused on notable models rather than dumping all 1000+ ids.
 *
 * Capabilities exposed today: chat (text + vision-language). HF's
 * non-chat tasks (TTS, STT, image-gen, embeddings) need separate
 * endpoint calls — those would be additional adapter files when we
 * actually want to use them.
 */

import type {
  ChatDispatcher,
  ChatModelInfo,
  ChatOptions,
  ChatResult,
} from './types';
import type { DiscoveryResult } from '../discover';
import {
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_CHAT_MODELS,
  HUGGINGFACE_ROUTING_POLICIES,
  type HuggingfaceRoutingPolicy,
} from '../catalogs/huggingface';
import {
  extractOpenAICompatToolCalls,
  toOpenAICompatMessages,
  type OpenAICompatChatResponse,
} from './openai-compat';

/** HF's router speaks the OpenAI-compat wire shape verbatim — no
 *  provider-specific quirks on the response side. Aliasing the shared
 *  type keeps existing imports stable; future HF-router-specific
 *  fields (sub-provider metadata, routing telemetry) can hang off the
 *  intersection without touching the call sites. */
type HfChatResponse = OpenAICompatChatResponse;

type HfListModelsResponse = {
  data?: Array<{ id: string }>;
};

/** Apply a routing policy suffix to a model id if one isn't already
 *  present. HF accepts `<id>:fastest`, `<id>:cheapest`,
 *  `<id>:preferred`, or `<id>:<sub-provider>`. We only auto-apply
 *  policies; pinned-provider suffixes the user typed themselves are
 *  left alone. */
export function applyRoutingSuffix(
  modelId: string,
  policy?: HuggingfaceRoutingPolicy | string,
): string {
  if (!policy) return modelId;
  // If the model id already carries a suffix, the user has been
  // explicit — respect it.
  if (modelId.includes(':')) return modelId;
  return `${modelId}:${policy}`;
}

async function hfChat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('huggingface-chat: apiKey required');
  if (!opts.model) throw new Error('huggingface-chat: model required');

  // `routing` is the HF-specific override read out of opts.extra. The
  // worker form writes it into params.huggingface_routing and the
  // call site passes it through. Defaults to no suffix → HF picks
  // the fastest provider.
  const routing = (opts.extra?.routing as string | undefined) ?? undefined;
  const model = applyRoutingSuffix(opts.model, routing);

  const tools = opts.tools && opts.tools.length > 0 ? opts.tools : undefined;

  const body: Record<string, unknown> = {
    model,
    messages: toOpenAICompatMessages(opts.messages),
    ...(tools ? { tools } : {}),
    ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
    ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
    ...(typeof opts.maxTokens === 'number' ? { max_tokens: opts.maxTokens } : {}),
    ...(typeof opts.topP === 'number' ? { top_p: opts.topP } : {}),
  };

  const res = await fetch(`${HUGGINGFACE_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`huggingface chat ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const parsed = (await res.json()) as HfChatResponse;
  const message = parsed.choices?.[0]?.message;
  const text = message?.content ?? '';
  const toolCalls = extractOpenAICompatToolCalls(message);
  return {
    text: text.trim(),
    // Echo the model HF says it actually served — useful for /traces
    // when :fastest routes to different sub-providers across runs.
    model: parsed.model || model,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    tokensIn: parsed.usage?.prompt_tokens,
    tokensOut: parsed.usage?.completion_tokens,
    cacheReadTokens: parsed.usage?.prompt_tokens_details?.cached_tokens,
    // HF doesn't expose a cache-write line item; leave cacheWriteTokens undefined.
  };
}

async function hfDiscover(apiKey: string): Promise<DiscoveryResult<ChatModelInfo>> {
  try {
    const res = await fetch(`${HUGGINGFACE_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        available: [...HUGGINGFACE_CHAT_MODELS],
        filtered: false,
        error: `hf /v1/models ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const parsed = (await res.json()) as HfListModelsResponse;
    const ids = new Set((parsed.data ?? []).map((m) => m.id));
    // HF returns hundreds — keep the curated catalog as the
    // dropdown population, but mark which of our curated picks are
    // actually live. If none of our curated picks are in the live
    // list (rare; happens if your key is restricted), fall back to
    // the full catalog so the dropdown still has options.
    const available = HUGGINGFACE_CHAT_MODELS.filter((m) => ids.has(m.id));
    return {
      available: available.length > 0 ? available : [...HUGGINGFACE_CHAT_MODELS],
      filtered: available.length > 0,
      error: null,
    };
  } catch (err) {
    return {
      available: [...HUGGINGFACE_CHAT_MODELS],
      filtered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const huggingfaceChatAdapter: ChatDispatcher = {
  providerId: 'huggingface',
  adapterName: 'huggingface-chat',
  chat: hfChat,
  discoverModels: hfDiscover,
  staticCatalog: () => HUGGINGFACE_CHAT_MODELS,
};

// Re-export the routing list so the UI can render the dropdown.
export { HUGGINGFACE_ROUTING_POLICIES };
export type { HuggingfaceRoutingPolicy };
