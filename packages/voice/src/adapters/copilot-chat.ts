/**
 * GitHub Copilot chat adapter.
 *
 * Copilot fronts a roster of frontier models (GPT, Claude, Gemini, o-series)
 * behind one OpenAI-compatible `/chat/completions` endpoint at
 * `api.githubcopilot.com`. Two things make it not-quite-vanilla openai-compat:
 *
 *   1. **Auth is a token exchange**, not a static key. The worker stores a
 *      GitHub OAuth token; `copilot-auth.ts` swaps it for a short-lived Copilot
 *      token and caches it. A 401 (token aged out) triggers one forced re-mint.
 *   2. **Editor headers** (`Editor-Version`, `Copilot-Integration-Id`,
 *      `x-initiator`, …) are required on every request, or Copilot 4xxs.
 *
 * Otherwise it shares the openai-compat message/tool translation + streamer.
 *
 * Thinking: Copilot's models reason via OpenAI-style `reasoning_effort`
 * (low/medium/high), which we map from `opts.thinkingBudget`. Unlike Anthropic,
 * chat-completions reasoning is NOT replayed across tool rounds (no signed
 * blocks to echo back), so we request it every round — no continuation guard.
 * Any `reasoning_content` the upstream surfaces is forwarded as reasoning deltas
 * by the shared streamer; `<think>` inlined into content is scrubbed.
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
import { COPILOT_BASE_URL, COPILOT_CHAT_MODELS } from '../catalogs/copilot';
import {
  extractOpenAICompatToolCalls,
  streamOpenAICompatChat,
  toOpenAICompatMessages,
  type OpenAICompatChatResponse,
} from './openai-compat';
import { scrubThinkBlocks } from './think-scrubber';
import { copilotHeaders, resolveCopilotToken } from './copilot-auth';

/** Map our token-budget hint to Copilot's `reasoning_effort` tier. Any positive
 *  budget turns reasoning on; the magnitude picks the tier. Returns undefined
 *  when thinking isn't requested, so the field is omitted. */
function copilotReasoningEffort(opts: ChatOptions): 'low' | 'medium' | 'high' | undefined {
  const b = typeof opts.thinkingBudget === 'number' ? opts.thinkingBudget : 0;
  if (b <= 0) return undefined;
  if (b < 2000) return 'low';
  if (b < 8000) return 'medium';
  return 'high';
}

/** Reasoning models reject sampling params — strip temperature/top_p from the
 *  options when reasoning is on (the tool loop already drops them under the
 *  gate; this is belt-and-suspenders for direct callers). */
function sanitizeForReasoning(opts: ChatOptions, reasoning: boolean): ChatOptions {
  if (!reasoning) return opts;
  const { temperature: _t, topP: _p, ...rest } = opts;
  return rest;
}

/** Run an authed Copilot call, re-minting the token once on a 401. */
async function withCopilotAuth<T>(key: string, run: (token: string) => Promise<T>): Promise<T> {
  const token = await resolveCopilotToken(key);
  try {
    return await run(token);
  } catch (err) {
    if (err instanceof ChatHttpError && err.status === 401) {
      const fresh = await resolveCopilotToken(key, true);
      return run(fresh);
    }
    throw err;
  }
}

async function copilotChat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.model) throw new Error('copilot-chat: model required');
  const effort = copilotReasoningEffort(opts);
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

  return withCopilotAuth(opts.apiKey, async (token) => {
    const res = await fetch(`${COPILOT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: copilotHeaders({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      signal: chatAbortSignal(o.signal, 120_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new ChatHttpError({
        provider: 'copilot',
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
      cacheReadTokens: parsed.usage?.prompt_tokens_details?.cached_tokens,
    };
  });
}

/** Streaming Copilot chat — OpenAI-compatible SSE via the shared streamer, with
 *  the Copilot token + editor headers and a one-shot re-mint on 401. */
function copilotChatStream(opts: ChatOptions, onDelta: ChatStreamSink): Promise<ChatResult> {
  if (!opts.model) throw new Error('copilot-chat: model required');
  const effort = copilotReasoningEffort(opts);
  const o = sanitizeForReasoning(opts, !!effort);
  return withCopilotAuth(opts.apiKey, (token) =>
    streamOpenAICompatChat(
      o,
      {
        url: `${COPILOT_BASE_URL}/chat/completions`,
        headers: copilotHeaders({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' }),
        provider: 'copilot',
        ...(effort ? { bodyExtra: { reasoning_effort: effort } } : {}),
      },
      onDelta,
    ),
  );
}

async function copilotDiscover(apiKey: string): Promise<DiscoveryResult<ChatModelInfo>> {
  try {
    const token = await resolveCopilotToken(apiKey);
    const res = await fetch(`${COPILOT_BASE_URL}/models`, {
      headers: copilotHeaders({ Authorization: `Bearer ${token}` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { available: [...COPILOT_CHAT_MODELS], filtered: false, error: `copilot /models: HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      data?: Array<{ id?: string; capabilities?: { type?: string }; model_picker_enabled?: boolean }>;
    };
    const available: ChatModelInfo[] = (body.data ?? [])
      .filter((m): m is { id: string; capabilities?: { type?: string }; model_picker_enabled?: boolean } => {
        if (typeof m.id !== 'string' || !m.id) return false;
        // Drop non-chat models (embeddings) and picker-hidden entries.
        if (m.model_picker_enabled === false) return false;
        const t = m.capabilities?.type;
        return !t || t === 'chat';
      })
      .map((m) => ({ id: m.id, label: m.id, description: 'Copilot model reported by your account.' }));
    return available.length > 0
      ? { available, filtered: true, error: null }
      : { available: [...COPILOT_CHAT_MODELS], filtered: false, error: null };
  } catch (e) {
    return { available: [...COPILOT_CHAT_MODELS], filtered: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const copilotChatAdapter: ChatDispatcher = {
  providerId: 'copilot',
  adapterName: 'copilot-chat',
  chat: copilotChat,
  chatStream: copilotChatStream,
  discoverModels: copilotDiscover,
  staticCatalog: () => COPILOT_CHAT_MODELS,
};
