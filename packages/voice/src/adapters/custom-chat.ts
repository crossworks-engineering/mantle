/**
 * Custom OpenAI-compatible cloud chat adapter.
 *
 * ONE adapter for the long tail of cloud providers that expose a standard
 * OpenAI `/chat/completions` endpoint behind an API key — DashScope/Qwen,
 * Z.ai/GLM, Moonshot/Kimi, Nvidia NIM, Novita, Together, Fireworks, Groq,
 * DeepInfra, Azure AI Foundry, and any other "bring your own base URL + key"
 * service. Rather than a bespoke adapter per vendor (the per-provider model some
 * agents take), the operator configures a route with provider `custom`, a Base
 * URL, an API key, and a model id; everything flows through the shared
 * `openai-compat` translation + streamer the xAI / HF / DeepSeek / local
 * adapters already use.
 *
 * Distinct from `local`:
 *   - `local`  = keyless self-hosted / LAN / tailnet (default localhost URL,
 *                optional Tailscale proxy, Bearer is cosmetic).
 *   - `custom` = the CLOUD path — Base URL and API key are BOTH required, there
 *                is no localhost default, and there is no tailnet routing.
 * Keep the split: point `local` at a gateway you run; point `custom` at a vendor.
 *
 * Base URL: per-route `opts.baseUrl` (REQUIRED). We append `/chat/completions`
 * and `/models`, so supply the OpenAI-style root including any version segment,
 * e.g. `https://api.z.ai/api/paas/v4` or `https://api.deepinfra.com/v1/openai`.
 *
 * Thinking: `opts.thinkingBudget` maps to the OpenAI-standard `reasoning_effort`
 * (low/medium/high) — the most widely-honoured reasoning knob across compat
 * endpoints; sampling params are dropped when it's on. It's only set when the
 * per-user thinking gate (Settings → Profile: live-thinking switch ON + a
 * positive budget) provides one, so a plain custom route never sends a field a
 * stricter endpoint might reject.
 * Streamed `reasoning_content` is forwarded by the shared streamer, and inline
 * `<think>` is scrubbed defensively.
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
import {
  extractOpenAICompatToolCalls,
  streamOpenAICompatChat,
  toOpenAICompatMessages,
  type OpenAICompatChatResponse,
} from './openai-compat';
import { scrubThinkBlocks } from './think-scrubber';

/** Resolve + normalise the per-route base URL. Required — a custom cloud route
 *  has no sensible default (unlike `local`, which falls back to localhost). */
function resolveBaseUrl(opts: ChatOptions): string {
  const raw = opts.baseUrl?.trim();
  if (!raw) {
    throw new Error(
      'custom-chat: baseUrl required — set the route Base URL to the provider’s OpenAI-compatible root (e.g. https://api.z.ai/api/paas/v4)',
    );
  }
  return raw.replace(/\/+$/, '');
}

/** Map our token-budget hint to OpenAI's `reasoning_effort` tier. Any positive
 *  budget turns reasoning on; the magnitude picks the tier. Undefined when
 *  thinking isn't requested, so the field is omitted entirely. Mirrors the
 *  Copilot adapter's tiering so the gate behaves consistently across providers. */
function customReasoningEffort(opts: ChatOptions): 'low' | 'medium' | 'high' | undefined {
  const b = typeof opts.thinkingBudget === 'number' ? opts.thinkingBudget : 0;
  if (b <= 0) return undefined;
  if (b < 2000) return 'low';
  if (b < 8000) return 'medium';
  return 'high';
}

/** Reasoning models reject sampling params — strip temperature/top_p when
 *  reasoning is on. The tool loop already drops them under the gate; this is
 *  belt-and-suspenders for direct callers. */
function sanitizeForReasoning(opts: ChatOptions, reasoning: boolean): ChatOptions {
  if (!reasoning) return opts;
  const { temperature: _t, topP: _p, ...rest } = opts;
  return rest;
}

async function customChat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('custom-chat: apiKey required');
  if (!opts.model) throw new Error('custom-chat: model required');
  const url = resolveBaseUrl(opts);
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

  const res = await fetch(`${url}/chat/completions`, {
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
      provider: 'custom',
      status: res.status,
      body: errBody,
      retryAfterMs: parseRetryAfterMs(res.headers),
    });
  }
  const parsed = (await res.json()) as OpenAICompatChatResponse & { model?: string };
  const message = parsed.choices?.[0]?.message;
  const text = scrubThinkBlocks(message?.content ?? '');
  const toolCalls = extractOpenAICompatToolCalls(message);
  return {
    text: text.trim(),
    model: parsed.model || o.model,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    tokensIn: parsed.usage?.prompt_tokens,
    tokensOut: parsed.usage?.completion_tokens,
    // OpenAI-compat cache-hit signal, when the endpoint reports it.
    cacheReadTokens: parsed.usage?.prompt_tokens_details?.cached_tokens,
  };
}

/** Streaming custom chat — OpenAI-compatible SSE via the shared streamer, with
 *  the route's Bearer key and (when the gate sets a budget) `reasoning_effort`. */
function customChatStream(opts: ChatOptions, onDelta: ChatStreamSink): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('custom-chat: apiKey required');
  if (!opts.model) throw new Error('custom-chat: model required');
  const url = resolveBaseUrl(opts);
  const effort = customReasoningEffort(opts);
  const o = sanitizeForReasoning(opts, !!effort);
  return streamOpenAICompatChat(
    o,
    {
      url: `${url}/chat/completions`,
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
      provider: 'custom',
      ...(effort ? { bodyExtra: { reasoning_effort: effort } } : {}),
    },
    onDelta,
  );
}

/**
 * Live discovery isn't possible from the keyless catalog route: `discoverModels`
 * only receives the api key, not the per-route Base URL a custom endpoint needs
 * to hit `/models`. Rather than error, we return an empty list with a hint — the
 * model dropdown's free-text "Use ‹typed›" affordance (`allowCustom`) lets the
 * operator commit the model id their endpoint serves. (Threading the route Base
 * URL through discovery is a future enhancement; see the model-audit handover.)
 */
async function customDiscover(_apiKey: string): Promise<DiscoveryResult<ChatModelInfo>> {
  return {
    available: [],
    filtered: false,
    error: 'Custom endpoint: type the model id your provider serves (live discovery needs the route Base URL).',
  };
}

export const customChatAdapter: ChatDispatcher = {
  providerId: 'custom',
  adapterName: 'custom-chat',
  chat: customChat,
  chatStream: customChatStream,
  discoverModels: customDiscover,
};
