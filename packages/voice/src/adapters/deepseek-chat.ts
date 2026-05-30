/**
 * DeepSeek chat adapter.
 *
 * DeepSeek's API is OpenAI-compatible at `https://api.deepseek.com`. We
 * talk to /chat/completions with the standard `{messages, model, ...}`
 * shape; auth is `Authorization: Bearer ${apiKey}`. Reference:
 * https://api-docs.deepseek.com/.
 *
 * Message + tool-call translation is shared via openai-compat.ts (same
 * helpers xAI and HuggingFace use). The DeepSeek-specific bit is the
 * **usage response shape**: cache hits surface as TOP-LEVEL
 * `usage.prompt_cache_hit_tokens` + `usage.prompt_cache_miss_tokens`,
 * NOT the OpenAI-compat `usage.prompt_tokens_details.cached_tokens`
 * shape. Both quirks are documented inline at the read sites below.
 *
 * Caching is AUTOMATIC — no cache_control markers needed. Prefix
 * matches trigger cache hits server-side at ~2% of fresh-input rate
 * (much steeper discount than Anthropic's ~10%). The adapter ignores
 * `opts.cacheControl` entirely because DeepSeek doesn't honour any
 * marker syntax.
 *
 * Discovery: DeepSeek doesn't officially document /v1/models but
 * OpenAI-compat APIs often implement it. We TRY the call; on failure
 * fall back to the static catalog with a "couldn't verify" hint.
 */

import type {
  ChatDispatcher,
  ChatModelInfo,
  ChatOptions,
  ChatResult,
} from './types';
import { ChatHttpError, parseRetryAfterMs } from './retry';
import type { DiscoveryResult } from '../discover';
import { DEEPSEEK_BASE_URL, DEEPSEEK_CHAT_MODELS } from '../catalogs/deepseek';
import {
  extractOpenAICompatToolCalls,
  toOpenAICompatMessages,
  type OpenAICompatChatResponse,
} from './openai-compat';

/** DeepSeek's chat response shape — the shared OpenAI-compat envelope
 *  with the cache-hit fields hung off `usage` as top-level keys
 *  (DeepSeek's non-standard cache reporting). */
type DeepseekChatResponse = OpenAICompatChatResponse & {
  id?: string;
  usage?: OpenAICompatChatResponse['usage'] & {
    /** Tokens in the prompt that hit the cache. Billed at ~2% of the
     *  fresh-input rate per https://api-docs.deepseek.com/guides/kv_cache. */
    prompt_cache_hit_tokens?: number;
    /** Tokens in the prompt that missed the cache. Billed at the
     *  fresh-input rate. Sum equals usage.prompt_tokens. */
    prompt_cache_miss_tokens?: number;
  };
};

type ListModelsResponse = {
  data?: Array<{ id: string }>;
};

async function deepseekChat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('deepseek-chat: apiKey required');
  if (!opts.model) throw new Error('deepseek-chat: model required');

  const tools = opts.tools && opts.tools.length > 0 ? opts.tools : undefined;

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toOpenAICompatMessages(opts.messages),
    ...(tools ? { tools } : {}),
    ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
    ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
    ...(typeof opts.maxTokens === 'number' ? { max_tokens: opts.maxTokens } : {}),
    ...(typeof opts.topP === 'number' ? { top_p: opts.topP } : {}),
    ...(opts.extra ?? {}),
  };

  const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
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
    throw new ChatHttpError({ provider: 'deepseek', status: res.status, body: errBody, retryAfterMs: parseRetryAfterMs(res.headers) });
  }
  const parsed = (await res.json()) as DeepseekChatResponse;
  const message = parsed.choices?.[0]?.message;
  const text = message?.content ?? '';
  const toolCalls = extractOpenAICompatToolCalls(message);
  return {
    text: text.trim(),
    model: parsed.model || opts.model,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    tokensIn: parsed.usage?.prompt_tokens,
    tokensOut: parsed.usage?.completion_tokens,
    // DeepSeek-specific: cache hits come back as
    // usage.prompt_cache_hit_tokens (not prompt_tokens_details.cached_tokens
    // like xAI / HF sub-providers). Surface as cacheReadTokens so the
    // trace's recordChatUsage records it under the same meta key every
    // other adapter uses.
    cacheReadTokens: parsed.usage?.prompt_cache_hit_tokens,
    // DeepSeek doesn't bill a cache-write line item — automatic caching
    // amortises into the regular cache-miss tokens. cacheWriteTokens
    // stays undefined.
  };
}

async function deepseekDiscover(
  apiKey: string,
): Promise<DiscoveryResult<ChatModelInfo>> {
  try {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        available: [...DEEPSEEK_CHAT_MODELS],
        filtered: false,
        error: `deepseek /models ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const parsed = (await res.json()) as ListModelsResponse;
    const ids = new Set((parsed.data ?? []).map((m) => m.id));
    const available = DEEPSEEK_CHAT_MODELS.filter((m) => ids.has(m.id));
    return {
      available:
        available.length > 0 ? available : [...DEEPSEEK_CHAT_MODELS],
      filtered: available.length > 0,
      error: null,
    };
  } catch (err) {
    return {
      available: [...DEEPSEEK_CHAT_MODELS],
      filtered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const deepseekChatAdapter: ChatDispatcher = {
  providerId: 'deepseek',
  adapterName: 'deepseek-chat',
  chat: deepseekChat,
  discoverModels: deepseekDiscover,
  staticCatalog: () => DEEPSEEK_CHAT_MODELS,
};
