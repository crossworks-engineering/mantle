/**
 * Mammouth chat adapter.
 *
 * Mammouth is an OpenRouter-style aggregator with an OpenAI-compatible API at
 * `https://api.mammouth.ai/v1`. We talk to `/chat/completions` with the
 * standard `{messages, model, ...}` shape; auth is `Authorization: Bearer`.
 * Reference: https://info.mammouth.ai/docs/api-quick-start/.
 *
 * Message + tool-call translation and streaming are shared via
 * openai-compat.ts (same helpers xAI, HF, DeepSeek and custom use). The
 * Mammouth-specific bits:
 *
 *   - Cost. Mammouth returns no `usage.cost`, and its ids are bare
 *     (`gpt-5.4`), so the OpenRouter-slug fallback table can't price them.
 *     `reportedCostUsd` is computed from the catalog's published rate
 *     (`mammouthCostUsd`), on both the one-shot and the streaming path.
 *   - Reasoning. `opts.thinkingBudget` maps to the OpenAI-standard
 *     `reasoning_effort`, the same tiering the custom adapter uses; Mammouth
 *     forwards it to the vendors that support it.
 *   - Discovery. `/models` lists every model the key can reach. Catalogued
 *     ones keep their price + description; uncatalogued chat ids are appended
 *     as plain entries so a new model is pickable before the catalog catches
 *     up (an aggregator adds models faster than we edit a file).
 *
 * Caching: no markers. Cache hits, when a vendor reports them, arrive in the
 * standard `prompt_tokens_details.cached_tokens` and are recorded as such.
 */

import type {
  ChatDispatcher,
  ChatModelInfo,
  ChatOptions,
  ChatResult,
  ChatStreamSink,
} from './types';
import { ChatHttpError, parseRetryAfterMs } from './retry';
import { chatAbortSignal } from './sse';
import type { DiscoveryResult } from '../discover';
import { MAMMOUTH_BASE_URL, MAMMOUTH_CHAT_MODELS, mammouthCostUsd } from '../catalogs/mammouth';
import {
  extractOpenAICompatToolCalls,
  mapOpenAICompatFinishReason,
  streamOpenAICompatChat,
  toOpenAICompatMessages,
  type OpenAICompatChatResponse,
} from './openai-compat';
import { customReasoningEffort, sanitizeForReasoning } from './custom-chat';
import { scrubThinkBlocks } from './think-scrubber';
import { errorMessage } from '@mantle/std';

type ListModelsResponse = {
  data?: Array<{ id: string }>;
};

/** Ids `/models` returns that are not chat models: embeddings and image
 *  output. Kept out of the chat dropdown. */
function isNonChatId(id: string): boolean {
  return /embedding|image/i.test(id);
}

/** Attach the catalog-priced cost, keyed on the REQUESTED id: the response's
 *  `model` can be the vendor's dated id, which the catalog doesn't list. */
function withCost(result: ChatResult, requestedModel: string): ChatResult {
  const cost = mammouthCostUsd(requestedModel, result.tokensIn, result.tokensOut);
  return cost == null ? result : { ...result, reportedCostUsd: cost };
}

async function mammouthChat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('mammouth-chat: apiKey required');
  if (!opts.model) throw new Error('mammouth-chat: model required');
  const effort = customReasoningEffort(opts);
  const o = sanitizeForReasoning(opts, !!effort);
  const tools = o.tools && o.tools.length > 0 ? o.tools : undefined;

  const body: Record<string, unknown> = {
    model: o.model,
    messages: toOpenAICompatMessages(o.messages),
    ...(tools ? { tools } : {}),
    ...(o.toolChoice ? { tool_choice: o.toolChoice } : {}),
    ...(typeof o.temperature === 'number' ? { temperature: o.temperature } : {}),
    ...(typeof o.maxTokens === 'number' ? { max_tokens: o.maxTokens } : {}),
    ...(typeof o.topP === 'number' ? { top_p: o.topP } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(o.extra ?? {}),
  };

  const res = await fetch(`${MAMMOUTH_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: chatAbortSignal(o.signal, 120_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new ChatHttpError({
      provider: 'mammouth',
      status: res.status,
      body: errBody,
      retryAfterMs: parseRetryAfterMs(res.headers),
    });
  }
  const parsed = (await res.json()) as OpenAICompatChatResponse & { model?: string };
  const message = parsed.choices?.[0]?.message;
  const text = scrubThinkBlocks(message?.content ?? '');
  const toolCalls = extractOpenAICompatToolCalls(message);
  const finishReason = mapOpenAICompatFinishReason(parsed.choices?.[0]?.finish_reason);
  return withCost(
    {
      text: text.trim(),
      model: parsed.model || o.model,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(finishReason ? { finishReason } : {}),
      tokensIn: parsed.usage?.prompt_tokens,
      tokensOut: parsed.usage?.completion_tokens,
      cacheReadTokens: parsed.usage?.prompt_tokens_details?.cached_tokens,
    },
    o.model,
  );
}

/** Streaming Mammouth chat: the shared OpenAI-compat streamer, plus the same
 *  catalog-priced cost the one-shot path attaches. The streaming path is the
 *  one the responder takes, so a cost set only in `chat()` would be lost. */
async function mammouthChatStream(opts: ChatOptions, onDelta: ChatStreamSink): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('mammouth-chat: apiKey required');
  if (!opts.model) throw new Error('mammouth-chat: model required');
  const effort = customReasoningEffort(opts);
  const o = sanitizeForReasoning(opts, !!effort);
  const result = await streamOpenAICompatChat(
    o,
    {
      url: `${MAMMOUTH_BASE_URL}/chat/completions`,
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
      provider: 'mammouth',
      ...(effort ? { bodyExtra: { reasoning_effort: effort } } : {}),
    },
    onDelta,
  );
  return withCost(result, o.model);
}

async function mammouthDiscover(apiKey: string): Promise<DiscoveryResult<ChatModelInfo>> {
  try {
    const res = await fetch(`${MAMMOUTH_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        available: [...MAMMOUTH_CHAT_MODELS],
        filtered: false,
        error: `mammouth /models ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const parsed = (await res.json()) as ListModelsResponse;
    const liveIds = (parsed.data ?? []).map((m) => m.id);
    const ids = new Set(liveIds);
    const catalogued = MAMMOUTH_CHAT_MODELS.filter((m) => ids.has(m.id));
    const known = new Set(MAMMOUTH_CHAT_MODELS.map((m) => m.id));
    const extra: ChatModelInfo[] = liveIds
      .filter((id) => !known.has(id) && !isNonChatId(id))
      .map((id) => ({
        id,
        label: id,
        description: 'Served by Mammouth; not in Mantle’s catalog yet, so cost is not tracked.',
      }));
    const available = [...catalogued, ...extra];
    return {
      available: available.length > 0 ? available : [...MAMMOUTH_CHAT_MODELS],
      filtered: available.length > 0,
      error: null,
      liveIds,
    };
  } catch (err) {
    return {
      available: [...MAMMOUTH_CHAT_MODELS],
      filtered: false,
      error: errorMessage(err),
    };
  }
}

export const mammouthChatAdapter: ChatDispatcher = {
  providerId: 'mammouth',
  adapterName: 'mammouth-chat',
  chat: mammouthChat,
  chatStream: mammouthChatStream,
  discoverModels: mammouthDiscover,
  staticCatalog: () => MAMMOUTH_CHAT_MODELS,
};
