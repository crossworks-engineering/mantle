/**
 * Shared OpenAI-compatible chat translation.
 *
 * Two chat providers in the catalogue speak the OpenAI-compat
 * `/v1/chat/completions` wire shape directly (snake_case fields,
 * tool_calls array on the assistant message, tool_call_id on tool
 * results):
 *   - xAI Grok (`api.x.ai/v1/chat/completions`)
 *   - Hugging Face Inference router (`router.huggingface.co/v1/chat/completions`)
 *
 * Before this module they each carried a near-identical copy of the
 * same ~120 LOC of message + tool-call translation. Now they share
 * one source of truth here, and provider-specific bits (auth header,
 * URL, HF's routing suffix, xAI's reasoning_effort extra) stay in
 * their adapter files.
 *
 * OpenRouter is NOT routed through this helper — it uses the
 * `@openrouter/sdk` typed client whose surface is camelCase
 * (`toolCalls`, `imageUrl`, `cacheControl`); the SDK does the
 * snake_case conversion internally on the wire. Mixing the two
 * shapes in one helper would either lose type safety or require
 * brittle name-mapping. Keep them separate.
 */

import type { ChatOptions, ChatToolCall } from './types';

// ─── Wire types ──────────────────────────────────────────────────────────────

/** OpenAI-shape tool call (assistant message). Matches both xAI's and
 *  HF's response shape exactly. */
export type OpenAICompatToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/** OpenAI-shape multimodal content parts. `image_url` is snake_case on
 *  the wire (renamed from the runtime's camelCase `imageUrl`). */
export type OpenAICompatTextBlock = { type: 'text'; text: string };
export type OpenAICompatImageBlock = {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
};

/** OpenAI-shape chat message. Tool messages use `tool_call_id`
 *  (snake_case). User content may be a plain string or a multimodal
 *  array (text + image_url) for vision-capable models. */
export type OpenAICompatMessage =
  | { role: 'system'; content: string }
  | {
      role: 'user';
      content:
        | string
        | Array<OpenAICompatTextBlock | OpenAICompatImageBlock>;
    }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAICompatToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** OpenAI-shape choice + usage envelope. Common ancestor of
 *  XaiChatResponse + HfChatResponse (kept narrow — adapters extend
 *  via intersection with provider-specific fields like xAI's
 *  `choices[].text` legacy fallback). */
export type OpenAICompatChatResponse = {
  model: string;
  choices: Array<{
    message?: {
      role: string;
      content?: string | null;
      tool_calls?: OpenAICompatToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenAI-compat cache hit signal — present on providers that
     *  surface their auto-caching (Cerebras, Together via HF; xAI).
     *  Absent on others; treat as 0 in that case. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

// ─── Message translation ────────────────────────────────────────────────────

/**
 * ChatOptions.messages → OpenAI-compat wire shape.
 *
 * Five transformations live here:
 *
 *   1. System block-array → joined string. These providers don't
 *      honour per-block cache_control breakpoints (xAI's caching is
 *      automatic + opaque; HF's sub-providers handle caching
 *      individually). Joining loses no semantic information — the
 *      flattened prefix caches the same way the segmented form would.
 *
 *   2. User multimodal content (text + image_url) → same shape with
 *      camelCase `imageUrl` renamed to snake_case `image_url`.
 *
 *   3. Assistant `toolCalls` (camelCase) → `tool_calls` (snake_case),
 *      content normalised to `null` when absent.
 *
 *   4. Tool messages → `tool_call_id` (snake_case) renamed from the
 *      runtime's `toolCallId`.
 *
 *   5. Plain strings pass through unchanged.
 */
export function toOpenAICompatMessages(
  messages: ChatOptions['messages'],
): OpenAICompatMessage[] {
  return messages.map((m): OpenAICompatMessage => {
    if (m.role === 'system') {
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
      const parts: Array<OpenAICompatTextBlock | OpenAICompatImageBlock> =
        m.content.map((p): OpenAICompatTextBlock | OpenAICompatImageBlock => {
          if (p.type === 'text') return { type: 'text', text: p.text };
          return {
            type: 'image_url',
            image_url: {
              url: p.imageUrl.url,
              ...(p.imageUrl.detail ? { detail: p.imageUrl.detail } : {}),
            },
          };
        });
      return { role: 'user', content: parts };
    }
    if (m.role === 'assistant') {
      const tc =
        'toolCalls' in m && m.toolCalls
          ? m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: c.function,
            }))
          : undefined;
      return {
        role: 'assistant',
        content: (m.content as string | null) ?? null,
        ...(tc ? { tool_calls: tc } : {}),
      };
    }
    // m.role === 'tool'
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  });
}

// ─── Tool-call extraction ───────────────────────────────────────────────────

/**
 * Pull normalised ChatToolCall[] off an OpenAI-compat response message.
 * Returns undefined when the model emitted no tool calls.
 *
 * Defensive: a missing `arguments` field becomes `'{}'` (matches what
 * the tool-loop's `parseToolArgs` will then accept as an empty call).
 */
export function extractOpenAICompatToolCalls(
  message: OpenAICompatChatResponse['choices'][number]['message'],
): ChatToolCall[] | undefined {
  const tc = message?.tool_calls;
  if (!tc || tc.length === 0) return undefined;
  return tc.map((c) => ({
    id: c.id,
    type: 'function' as const,
    function: {
      name: c.function.name,
      arguments: c.function.arguments ?? '{}',
    },
  }));
}
