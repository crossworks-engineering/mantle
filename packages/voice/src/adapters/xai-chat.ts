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
  ChatToolCall,
} from './types';
import type { DiscoveryResult } from '../discover';
import { XAI_BASE_URL, XAI_CHAT_MODELS } from '../catalogs/xai';

type XaiToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type XaiChatResponse = {
  id: string;
  model: string;
  choices: Array<{
    message?: {
      role: string;
      content?: string | null;
      tool_calls?: XaiToolCall[];
    };
    text?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** xAI's automatic prompt caching surfaces hits via the OpenAI-
     *  compatible `prompt_tokens_details.cached_tokens` field. No
     *  cache_control markers needed — Grok applies caching server-side
     *  based on prefix match. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

/** xAI image content part — OpenAI-compat shape with snake_case
 *  image_url on the wire (Grok's vision endpoint accepts this exact
 *  shape since their API mirrors OpenAI's). */
type XaiImageBlock = {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
};

type XaiTextBlock = { type: 'text'; text: string };

/** xAI accepts OpenAI-shape messages. Tool messages use `tool_call_id`
 *  on the wire (snake_case); the adapter converts our `toolCallId`.
 *  User content can be a plain string OR an array of content parts
 *  (text + image_url) for vision-capable Grok models. */
type XaiMessage =
  | { role: 'system'; content: string }
  | {
      role: 'user';
      content: string | Array<XaiTextBlock | XaiImageBlock>;
    }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: XaiToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

function toXaiMessages(messages: ChatOptions['messages']): XaiMessage[] {
  return messages.map((m): XaiMessage => {
    if (m.role === 'system') {
      // Flatten array-form system to a concatenated string. xAI's
      // automatic prompt caching is opaque + prefix-based, so the
      // joined text caches the same way the segmented form would
      // (just without per-block cache_control breakpoints, which
      // xAI doesn't expose anyway).
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => p.text).join('\n\n');
      return { role: 'system', content };
    }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        return { role: 'user', content: m.content };
      }
      // Multimodal array: translate text + image_url parts. xAI's
      // wire format is camelCase imageUrl → snake_case image_url, so
      // we rename here.
      const parts: Array<XaiTextBlock | XaiImageBlock> = m.content.map(
        (p): XaiTextBlock | XaiImageBlock => {
          if (p.type === 'text') return { type: 'text', text: p.text };
          return {
            type: 'image_url',
            image_url: {
              url: p.imageUrl.url,
              ...(p.imageUrl.detail ? { detail: p.imageUrl.detail } : {}),
            },
          };
        },
      );
      return { role: 'user', content: parts };
    }
    if (m.role === 'assistant') {
      const tc = 'toolCalls' in m && m.toolCalls
        ? m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: c.function }))
        : undefined;
      return {
        role: 'assistant',
        content: (m.content as string | null) ?? null,
        ...(tc ? { tool_calls: tc } : {}),
      };
    }
    // tool
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  });
}

function extractXaiToolCalls(
  message: XaiChatResponse['choices'][number]['message'],
): ChatToolCall[] | undefined {
  const tc = message?.tool_calls;
  if (!tc || tc.length === 0) return undefined;
  return tc.map((c) => ({
    id: c.id,
    type: 'function' as const,
    function: { name: c.function.name, arguments: c.function.arguments ?? '{}' },
  }));
}

type ListModelsResponse = {
  data?: Array<{ id: string }>;
};

async function xaiChat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('xai-chat: apiKey required');
  if (!opts.model) throw new Error('xai-chat: model required');

  const tools = opts.tools && opts.tools.length > 0 ? opts.tools : undefined;

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toXaiMessages(opts.messages),
    ...(tools ? { tools } : {}),
    ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
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
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`xai chat ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const parsed = (await res.json()) as XaiChatResponse;
  // OpenAI-compat shape — text lives at choices[0].message.content,
  // with a fallback to legacy choices[0].text in case of unusual
  // response routing.
  const message = parsed.choices?.[0]?.message;
  const text = message?.content ?? parsed.choices?.[0]?.text ?? '';
  const toolCalls = extractXaiToolCalls(message);
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

export const xaiChatAdapter: ChatDispatcher = {
  providerId: 'xai',
  adapterName: 'xai-chat',
  chat: xaiChat,
  discoverModels: xaiDiscover,
  staticCatalog: () => XAI_CHAT_MODELS,
};
