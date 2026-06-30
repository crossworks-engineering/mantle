/**
 * xAI (Grok) chat adapter.
 *
 * xAI's API is OpenAI-compatible at `https://api.x.ai/v1`. We talk to
 * /v1/chat/completions with the standard `{messages, model, ...}`
 * shape. Auth is Bearer token (`XAI_API_KEY`).
 *
 * Discovery: xAI doesn't officially document a /v1/models endpoint
 * but OpenAI-compat APIs almost always implement it. We TRY the call;
 * on failure (404 or other) we fall back to the static catalog with
 * a "couldn't verify" hint so the UI is still usable.
 *
 * Reasoning models: grok-4.20-reasoning accepts a `reasoning_effort`
 * field (low|medium|high). We forward it via `opts.extra` when set,
 * so the adapter stays generic but power-users can still steer.
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
import { XAI_BASE_URL, XAI_CHAT_MODELS } from '../catalogs/xai';
import {
  extractOpenAICompatToolCalls,
  streamOpenAICompatChat,
  toOpenAICompatMessages,
  type OpenAICompatChatResponse,
} from './openai-compat';
import { scrubThinkBlocks } from './think-scrubber';

/** xAI's chat response shape — the shared OpenAI-compat envelope plus
 *  one xAI-specific quirk: some routes return `choices[].text` as a
 *  legacy fallback when `message.content` is empty. */
type XaiChatResponse = OpenAICompatChatResponse & {
  id: string;
  choices: Array<
    OpenAICompatChatResponse['choices'][number] & { text?: string }
  >;
};

type ListModelsResponse = {
  data?: Array<{ id: string }>;
};

async function xaiChat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('xai-chat: apiKey required');
  if (!opts.model) throw new Error('xai-chat: model required');

  const tools = opts.tools && opts.tools.length > 0 ? opts.tools : undefined;

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toOpenAICompatMessages(opts.messages),
    ...(tools ? { tools } : {}),
    // xAI rejects tool_choice with no tools (400) — e.g. the force-final pass.
    // Without tools there's nothing to choose, so omit it (still forces text).
    ...(opts.toolChoice && tools ? { tool_choice: opts.toolChoice } : {}),
    ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
    ...(typeof opts.maxTokens === 'number' ? { max_tokens: opts.maxTokens } : {}),
    ...(typeof opts.topP === 'number' ? { top_p: opts.topP } : {}),
    ...(opts.extra ?? {}),
  };

  const res = await fetch(`${XAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: chatAbortSignal(opts.signal, 60_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new ChatHttpError({ provider: 'xai', status: res.status, body: errBody, retryAfterMs: parseRetryAfterMs(res.headers) });
  }
  const parsed = (await res.json()) as XaiChatResponse;
  // OpenAI-compat shape — text lives at choices[0].message.content,
  // with a fallback to legacy choices[0].text in case of unusual
  // response routing.
  const message = parsed.choices?.[0]?.message;
  const text = scrubThinkBlocks(message?.content ?? parsed.choices?.[0]?.text ?? '');
  const toolCalls = extractOpenAICompatToolCalls(message);
  return {
    text: text.trim(),
    model: parsed.model || opts.model,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    tokensIn: parsed.usage?.prompt_tokens,
    tokensOut: parsed.usage?.completion_tokens,
    cacheReadTokens: parsed.usage?.prompt_tokens_details?.cached_tokens,
    // xAI has no cache-write line item — automatic caching is opaque.
  };
}

async function xaiDiscover(apiKey: string): Promise<DiscoveryResult<ChatModelInfo>> {
  try {
    const res = await fetch(`${XAI_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // 404 here means xAI hasn't implemented /v1/models — that's
      // fine, we fall back to the static catalog with a hint.
      const body = await res.text().catch(() => '');
      return {
        available: [...XAI_CHAT_MODELS],
        filtered: false,
        error: `xai /v1/models ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const parsed = (await res.json()) as ListModelsResponse;
    const ids = new Set((parsed.data ?? []).map((m) => m.id));
    const available = XAI_CHAT_MODELS.filter((m) => ids.has(m.id));
    return {
      // If the live list has no overlap (e.g. xAI returns no models
      // due to an account issue), fall back to the static catalog
      // rather than show an empty dropdown.
      available: available.length > 0 ? available : [...XAI_CHAT_MODELS],
      filtered: available.length > 0,
      error: null,
    };
  } catch (err) {
    return {
      available: [...XAI_CHAT_MODELS],
      filtered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Streaming xAI chat — OpenAI-compatible SSE via the shared streamer. */
function xaiChatStream(opts: ChatOptions, onDelta: ChatStreamSink): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('xai-chat: apiKey required');
  if (!opts.model) throw new Error('xai-chat: model required');
  return streamOpenAICompatChat(
    opts,
    {
      url: `${XAI_BASE_URL}/chat/completions`,
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
      provider: 'xai',
    },
    onDelta,
  );
}

export const xaiChatAdapter: ChatDispatcher = {
  providerId: 'xai',
  adapterName: 'xai-chat',
  chat: xaiChat,
  chatStream: xaiChatStream,
  discoverModels: xaiDiscover,
  staticCatalog: () => XAI_CHAT_MODELS,
};
