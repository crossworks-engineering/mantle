/**
 * Anthropic (Claude) chat adapter.
 *
 * Translates between Mantle's OpenAI-compat `ChatOptions.messages`
 * shape and Anthropic's native /v1/messages endpoint, which uses:
 *   - A separate `system` top-level field (not a role in messages)
 *   - `messages` containing ONLY user/assistant turns (alternating)
 *   - `max_tokens` is REQUIRED, not optional — we default to 4096
 *
 * Auth uses TWO headers: `x-api-key` for the secret + a fixed
 * `anthropic-version: 2023-06-01`. Without anthropic-version the API
 * returns 400.
 *
 * Discovery hits GET /v1/models. Anthropic paginates with
 * `has_more`/`last_id`; for the first page (default limit 20) we
 * just take what we get — current model count fits comfortably under
 * the default page size.
 *
 * Vision: every current Claude model supports image content. The
 * adapter doesn't translate image content yet (our ChatOptions only
 * carries `content: string` per message), but the field is there to
 * extend when we add vision-shaped workers.
 */

import type {
  ChatDispatcher,
  ChatModelInfo,
  ChatOptions,
  ChatResult,
} from './types';
import type { DiscoveryResult } from '../discover';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_CHAT_MODELS,
} from '../catalogs/anthropic';

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type AnthropicResponse = {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string } | { type: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

type AnthropicListModelsResponse = {
  data?: Array<{
    id: string;
    display_name?: string;
    type?: string;
    created_at?: string;
  }>;
};

/**
 * Pull the system message(s) out of an OpenAI-style messages array
 * and concatenate them into the single top-level string Anthropic
 * expects. Returns the remaining user/assistant turns.
 */
function splitSystemAndMessages(
  messages: ChatOptions['messages'],
): { system: string; rest: AnthropicMessage[] } {
  const sys: string[] = [];
  const rest: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      sys.push(m.content);
    } else {
      // Anthropic's `messages` array only takes user/assistant. If a
      // caller somehow inserts another role, drop it rather than
      // letting the API 400.
      rest.push({ role: m.role as 'user' | 'assistant', content: m.content });
    }
  }
  return { system: sys.join('\n\n'), rest };
}

async function anthropicChat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('anthropic-chat: apiKey required');
  if (!opts.model) throw new Error('anthropic-chat: model required');

  const { system, rest } = splitSystemAndMessages(opts.messages);

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: rest,
    // max_tokens is REQUIRED on the Messages API. Default to a sane
    // ceiling; callers override via opts.maxTokens.
    max_tokens: opts.maxTokens ?? 4096,
    ...(system ? { system } : {}),
    ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
    ...(typeof opts.topP === 'number' ? { top_p: opts.topP } : {}),
    ...(opts.extra ?? {}),
  };

  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`anthropic chat ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const parsed = (await res.json()) as AnthropicResponse;
  // Response shape: content is an array of blocks; the first text
  // block carries the reply. Other blocks may exist for tool use,
  // which we ignore for the chat-only path.
  const textBlock = parsed.content.find(
    (c): c is { type: 'text'; text: string } => c.type === 'text',
  );
  return {
    text: (textBlock?.text ?? '').trim(),
    model: parsed.model || opts.model,
    tokensIn: parsed.usage?.input_tokens,
    tokensOut: parsed.usage?.output_tokens,
  };
}

async function anthropicDiscover(
  apiKey: string,
): Promise<DiscoveryResult<ChatModelInfo>> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/models?limit=100`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        available: [...ANTHROPIC_CHAT_MODELS],
        filtered: false,
        error: `anthropic /v1/models ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const parsed = (await res.json()) as AnthropicListModelsResponse;
    // The Models API can return BOTH the dated id ('claude-haiku-4-5-
    // 20251001') AND the alias ('claude-haiku-4-5'). Our catalog uses
    // the alias for newer models; match against both.
    const ids = new Set((parsed.data ?? []).map((m) => m.id));
    const available = ANTHROPIC_CHAT_MODELS.filter(
      (m) =>
        ids.has(m.id) ||
        // Match dated variants (claude-haiku-4-5 ↔ claude-haiku-4-5-20251001)
        [...ids].some((live) => live.startsWith(`${m.id}-`)),
    );
    return {
      available: available.length > 0 ? available : [...ANTHROPIC_CHAT_MODELS],
      filtered: available.length > 0,
      error: null,
    };
  } catch (err) {
    return {
      available: [...ANTHROPIC_CHAT_MODELS],
      filtered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const anthropicChatAdapter: ChatDispatcher = {
  providerId: 'anthropic',
  adapterName: 'anthropic-chat',
  chat: anthropicChat,
  discoverModels: anthropicDiscover,
  staticCatalog: () => ANTHROPIC_CHAT_MODELS,
};
