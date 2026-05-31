/**
 * Local chat adapter — talks to a self-hosted OpenAI-compatible chat server
 * (Ollama, LM Studio, llama.cpp, vLLM) on your own hardware or a LAN / tailnet
 * box. The privacy + cost path for chat: run an open model (gemma, llama,
 * mistral) for the summarizer / extractor / reflector / responder and keep the
 * conversation on a machine you control, with a cloud model as the backup route
 * (see docs/chat-failover.md).
 *
 * Base URL precedence: per-route `opts.baseUrl` (so primary + backup can target
 * different hosts) → `MANTLE_LOCAL_CHAT_URL` env → `http://localhost:11434/v1`
 * (Ollama's default; LM Studio is usually `http://<host>:1234/v1`). Keyless —
 * local servers ignore the Bearer, sent only for OpenAI-API conformance.
 *
 * OpenAI-compatible wire shape, so it shares the `openai-compat` translation
 * helpers with the xAI / Hugging Face adapters. `getChatAdapter` wraps it with
 * `withChatRetry` (it isn't OpenRouter), so transient 429/5xx/network errors
 * retry before the primary→backup failover layer takes over.
 */

import type { ChatDispatcher, ChatModelInfo, ChatOptions, ChatResult } from './types';
import { ChatHttpError, parseRetryAfterMs } from './retry';
import type { DiscoveryResult } from '../discover';
import {
  extractOpenAICompatToolCalls,
  toOpenAICompatMessages,
  type OpenAICompatChatResponse,
} from './openai-compat';

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

/** Resolved per-call so a config change takes effect without a restart. */
function baseUrl(override?: string): string {
  return (override || process.env.MANTLE_LOCAL_CHAT_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function localChat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.model) throw new Error('local-chat: model required');

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

  // Local generation can be slow on CPU; allow a generous ceiling. A box that's
  // OFF refuses fast (fed to the failover layer); a hang hits this timeout.
  const res = await fetch(`${baseUrl(opts.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey || 'local'}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new ChatHttpError({
      provider: 'local',
      status: res.status,
      body: errBody,
      retryAfterMs: parseRetryAfterMs(res.headers),
    });
  }
  const parsed = (await res.json()) as OpenAICompatChatResponse & { model?: string };
  const message = parsed.choices?.[0]?.message;
  const text = message?.content ?? '';
  const toolCalls = extractOpenAICompatToolCalls(message);
  return {
    text: text.trim(),
    model: parsed.model || opts.model,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    tokensIn: parsed.usage?.prompt_tokens,
    tokensOut: parsed.usage?.completion_tokens,
  };
}

async function localChatDiscover(_apiKey: string): Promise<DiscoveryResult<ChatModelInfo>> {
  // Whatever the local server is currently serving (env-default host — the form
  // verifies a specific route live with Test chat). `/v1/models` doesn't report
  // context windows, so we list ids only.
  try {
    const res = await fetch(`${baseUrl()}/models`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      return { available: [], filtered: false, error: `local /v1/models: HTTP ${res.status}` };
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const available: ChatModelInfo[] = (body.data ?? [])
      .filter((m): m is { id: string } => typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        label: m.id,
        description: 'Local model reported by your server.',
      }));
    return { available, filtered: false, error: null };
  } catch (e) {
    return { available: [], filtered: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const localChatAdapter: ChatDispatcher = {
  providerId: 'local',
  adapterName: 'local-chat',
  chat: localChat,
  discoverModels: localChatDiscover,
};
