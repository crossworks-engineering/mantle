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

import type { ChatOptions, ChatResult, ChatStreamSink, ChatToolCall } from './types';
import { ChatHttpError, parseRetryAfterMs } from './retry';
import { readSSE, safeDelta } from './sse';
import { StreamingThinkScrubber, scrubThinkBlocks } from './think-scrubber';

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

// ─── Streaming ────────────────────────────────────────────────────────────────

/** One streamed OpenAI-compat chunk. `delta.content` is the visible text;
 *  `delta.reasoning_content` is the (DeepSeek-style) reasoning channel;
 *  `delta.tool_calls` arrive as fragments accumulated by `index`. Usage rides
 *  the final chunk when `stream_options.include_usage` is set. */
type OpenAICompatStreamChunk = {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

/** Per-call configuration for {@link streamOpenAICompatChat}: the provider's
 *  completions URL, request headers, a provider tag for error reporting, and any
 *  provider-specific body fields (xAI's `reasoning_effort` rides `opts.extra`, so
 *  most adapters need none). */
export type OpenAICompatStreamConfig = {
  url: string;
  headers: Record<string, string>;
  provider: string;
  bodyExtra?: Record<string, unknown>;
  /** Override the fetch implementation (e.g. the local adapter's `tailnetFetch`
   *  to reach a NAT'd box). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * Streaming counterpart of an OpenAI-compat `chat()` — sets `stream:true` (+
 * `stream_options.include_usage` so the terminal chunk still carries token
 * counts), fires `onDelta` per text/reasoning chunk, accumulates tool-call
 * argument fragments by index, and resolves to the same `ChatResult` shape the
 * one-shot call returns. Shared by every OpenAI-compatible adapter (xAI, HF,
 * DeepSeek, local).
 *
 * Honours `opts.signal`: it's threaded into the fetch (so a user Stop aborts the
 * HTTP stream), and on abort the reader stops and we return the PARTIAL reply
 * (dropping half-formed tool-call fragments) instead of throwing — so the turn
 * finalizes with whatever streamed.
 */
export async function streamOpenAICompatChat(
  opts: ChatOptions,
  cfg: OpenAICompatStreamConfig,
  onDelta: ChatStreamSink,
): Promise<ChatResult> {
  const tools = opts.tools && opts.tools.length > 0 ? opts.tools : undefined;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toOpenAICompatMessages(opts.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(tools ? { tools } : {}),
    ...(opts.toolChoice && tools ? { tool_choice: opts.toolChoice } : {}),
    ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
    ...(typeof opts.maxTokens === 'number' ? { max_tokens: opts.maxTokens } : {}),
    ...(typeof opts.topP === 'number' ? { top_p: opts.topP } : {}),
    ...(cfg.bodyExtra ?? {}),
    ...(opts.extra ?? {}),
  };

  // Stopped before we even sent — don't spend the request.
  if (opts.signal?.aborted) return { text: '', model: opts.model };

  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(cfg.url, {
    method: 'POST',
    headers: cfg.headers,
    body: JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok || !res.body) {
    const errBody = await res.text().catch(() => '');
    throw new ChatHttpError({
      provider: cfg.provider,
      status: res.status,
      body: errBody,
      retryAfterMs: parseRetryAfterMs(res.headers),
    });
  }

  let text = '';
  let reasoning = '';
  let model = opts.model;
  let usage: OpenAICompatStreamChunk['usage'];
  const toolAccum = new Map<number, { id: string; name: string; args: string }>();
  // Some open/local models (DeepSeek-R1, Qwen QwQ, many GGUF builds) inline their
  // chain-of-thought as `<think>…</think>` in `delta.content` instead of using
  // the `reasoning_content` channel. Scrub it per-delta so raw reasoning never
  // reaches the user or the persisted reply. No-op for models that don't.
  const scrubber = new StreamingThinkScrubber();

  try {
    for await (const payload of readSSE(res.body, opts.signal)) {
      if (opts.signal?.aborted) break;
      if (payload === '[DONE]') break;
      let chunk: OpenAICompatStreamChunk;
      try {
        chunk = JSON.parse(payload) as OpenAICompatStreamChunk;
      } catch {
        continue; // a keep-alive or malformed frame — skip it
      }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        // Route inline <think> blocks to the reasoning channel; only the visible
        // remainder accumulates into `text` and streams as a text delta.
        const visible = scrubber.feed(delta.content);
        if (visible) {
          text += visible;
          safeDelta(onDelta, { type: 'text', text: visible });
        }
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        reasoning += delta.reasoning_content;
        safeDelta(onDelta, { type: 'reasoning', text: delta.reasoning_content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const f of delta.tool_calls) {
          const idx = typeof f?.index === 'number' ? f.index : 0;
          const cur = toolAccum.get(idx) ?? { id: '', name: '', args: '' };
          if (f.id) cur.id = f.id;
          if (f.function?.name) cur.name = f.function.name;
          if (typeof f.function?.arguments === 'string') cur.args += f.function.arguments;
          toolAccum.set(idx, cur);
        }
      }
    }
  } catch (err) {
    // A user Stop aborts the fetch → an AbortError surfaces here; that's not a
    // failure, so fall through and return the partial. Anything else is real.
    if (!opts.signal?.aborted) throw err;
  }

  // Flush any partial tag the scrubber held at the boundary. If a block was
  // left unterminated the tail is discarded (leaking partial reasoning is worse
  // than a slightly truncated answer); otherwise the held prose surfaces.
  const tail = scrubber.flush();
  if (tail) {
    text += tail;
    safeDelta(onDelta, { type: 'text', text: tail });
  }

  // Stopped: return the visible text so far (drop half-formed tool fragments —
  // the turn loop sees text + no tools and finalizes it as the partial answer).
  if (opts.signal?.aborted) {
    return {
      text: text.trim(),
      model,
      tokensIn: usage?.prompt_tokens,
      tokensOut: usage?.completion_tokens,
    };
  }

  const toolCalls: ChatToolCall[] = [...toolAccum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c)
    .filter((c) => c.name)
    .map((c) => ({
      id: c.id || `call_${c.name}`,
      type: 'function' as const,
      function: { name: c.name, arguments: c.args || '{}' },
    }));

  return {
    text: text.trim(),
    model,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    tokensIn: usage?.prompt_tokens,
    tokensOut: usage?.completion_tokens,
    cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens,
  };
}
