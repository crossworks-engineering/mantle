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
  ChatToolCall,
} from './types';
import type { DiscoveryResult } from '../discover';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_CHAT_MODELS,
} from '../catalogs/anthropic';

/** Anthropic content blocks. `string` content is the simple shape; the
 *  array form is required when any block needs a `cache_control` marker
 *  or when carrying tool_use / tool_result blocks. */
type AnthropicTextBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  /** Set on the tool result when our local handler errored — Claude
   *  uses this to decide whether to retry vs. surface the failure. */
  is_error?: boolean;
};

/** Anthropic image block. The `source` shape varies by encoding:
 *  - base64: `{type:'base64', media_type, data}` for inline bytes.
 *  - url: `{type:'url', url}` for fetchable URLs (newer API).
 *  We support both via a discriminated union — the data-URL form
 *  (`data:image/png;base64,...`) the runtime usually sends gets
 *  split into the base64 source shape Anthropic expects. */
type AnthropicImageBlock = {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock;

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

/** The top-level `system` field accepts either a plain string OR an
 *  array of text blocks. Block form is required when the system prompt
 *  carries a cache_control marker. */
type AnthropicSystemField = string | AnthropicTextBlock[];

/** Anthropic's tool declaration shape on the request. */
type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

type AnthropicResponse = {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  /** Multi-block response. Text blocks carry narrative content;
   *  tool_use blocks carry the model's tool-call requests. Both can
   *  appear in the same response — text-then-tool-use is the typical
   *  shape when the model says "I'll look this up" before calling. */
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: string }
  >;
  stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens' | string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    /** Tokens served from the prompt cache, billed at ~10% of the
     *  fresh-input rate. Present when cache_control breakpoints land
     *  on a re-sent prefix. */
    cache_read_input_tokens?: number;
    /** Tokens written *into* the cache on this call, billed at ~1.25× of
     *  the fresh-input rate. The first call after a cache_control marker
     *  pays this; subsequent calls within the 5-minute TTL pay
     *  cache_read instead. */
    cache_creation_input_tokens?: number;
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
 * Translate ChatOptions.messages → Anthropic's request shape.
 *
 * Three transformations live here:
 *
 *   1. **System extraction.** System role → top-level `system` field
 *      (Anthropic doesn't accept system as a message role). Multiple
 *      systems are joined with blank-line separators.
 *
 *   2. **Assistant tool calls.** `{role:'assistant', toolCalls:[...]}` →
 *      assistant message with tool_use blocks. The model's prior
 *      tool_use blocks must be re-sent verbatim (with the same ids)
 *      so the matching tool_result the next user turn carries pairs
 *      correctly.
 *
 *   3. **Tool results.** `{role:'tool', toolCallId, content}` → user
 *      message with a tool_result content block. Anthropic models tool
 *      results as USER turns (not a separate tool role like OpenAI),
 *      because conceptually the user is feeding tool output back to
 *      the assistant. The runtime sees this as a `tool` message in
 *      its own grammar; we translate at the boundary.
 *
 * The runtime emits tool messages in OpenAI ordering — assistant turn
 * with multiple tool_calls, then one `tool` message per result. We
 * collapse consecutive tool messages into a single user message with
 * multiple tool_result blocks (Anthropic's preferred shape; sending
 * separate user messages each carrying one tool_result also works but
 * adds turn overhead).
 */
function splitSystemAndMessages(
  messages: ChatOptions['messages'],
): { system: string; systemBlocks: AnthropicTextBlock[]; rest: AnthropicMessage[] } {
  const sys: string[] = [];
  // When ANY system message arrives in block form (carrying its own
  // cache_control markers), we accumulate blocks here and return them
  // as the systemField — preserving per-block cache breakpoints.
  const systemBlocks: AnthropicTextBlock[] = [];
  let sawBlockSystem = false;
  const rest: AnthropicMessage[] = [];

  // Collect consecutive `tool` messages so they coalesce into a single
  // user turn (per the comment above).
  let pendingToolResults: AnthropicToolResultBlock[] = [];
  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    rest.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const m of messages) {
    if (m.role === 'system') {
      flushToolResults();
      if (typeof m.content === 'string') {
        // Plain-string system: accumulate both ways. If a later
        // system message arrives in block form, the joined string
        // becomes the first block + the others follow.
        sys.push(m.content);
        systemBlocks.push({ type: 'text', text: m.content });
      } else {
        // Block-form system: preserve per-block cache_control markers.
        sawBlockSystem = true;
        for (const part of m.content) {
          systemBlocks.push({
            type: 'text',
            text: part.text,
            ...(part.cacheControl ? { cache_control: part.cacheControl } : {}),
          });
        }
      }
      continue;
    }
    if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      });
      continue;
    }
    flushToolResults();
    if (m.role === 'user') {
      // String content: pass through.
      if (typeof m.content === 'string') {
        rest.push({ role: 'user', content: m.content });
        continue;
      }
      // Array content (multimodal vision turn): translate each part
      // to Anthropic's block shape. text → text block; image_url →
      // image block (split data-URL into base64 source). Unknown
      // shapes are dropped rather than letting the API 400.
      const blocks: AnthropicContentBlock[] = [];
      for (const part of m.content) {
        if (part.type === 'text') {
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          const block = toAnthropicImageBlock(part.imageUrl.url);
          if (block) blocks.push(block);
        }
      }
      rest.push({ role: 'user', content: blocks });
      continue;
    }
    // assistant — may have content, toolCalls, or both
    const hasToolCalls =
      'toolCalls' in m && Array.isArray(m.toolCalls) && m.toolCalls.length > 0;
    if (!hasToolCalls) {
      rest.push({
        role: 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
      });
      continue;
    }
    // Build a mixed content array: text block first (if any), then
    // every tool_use block in original order. Empty text blocks are
    // omitted — Anthropic rejects empty text content.
    const blocks: AnthropicContentBlock[] = [];
    if (typeof m.content === 'string' && m.content.length > 0) {
      blocks.push({ type: 'text', text: m.content });
    }
    for (const tc of m.toolCalls ?? []) {
      let parsedInput: Record<string, unknown>;
      try {
        const obj = JSON.parse(tc.function.arguments || '{}');
        parsedInput =
          obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
      } catch {
        // Anthropic requires `input` to be a parsed object. If the
        // upstream caller's stringified args don't parse, send {} —
        // the loop's `tool-args` parser will surface the error in
        // the tool_result on the next round.
        parsedInput = {};
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      });
    }
    rest.push({ role: 'assistant', content: blocks });
  }
  flushToolResults();
  return {
    system: sys.join('\n\n'),
    // Only surface the block array when the caller actually sent
    // pre-segmented system blocks. Otherwise the chat fn picks the
    // plain string path (cheaper to serialise, identical semantically
    // without per-block cache markers).
    systemBlocks: sawBlockSystem ? systemBlocks : [],
    rest,
  };
}

/** Translate ChatOptions.tools → Anthropic's `tools` field shape. */
function buildAnthropicTools(opts: ChatOptions): AnthropicTool[] | undefined {
  if (!opts.tools || opts.tools.length === 0) return undefined;
  return opts.tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/** Pull tool_use blocks off the Anthropic response and normalise. */
function extractAnthropicToolCalls(
  parsed: AnthropicResponse,
): ChatToolCall[] | undefined {
  const uses = parsed.content.filter(
    (c): c is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
      c.type === 'tool_use',
  );
  if (uses.length === 0) return undefined;
  return uses.map((u) => ({
    id: u.id,
    type: 'function',
    function: {
      name: u.name,
      // Stringify Anthropic's parsed `input` so the loop's single
      // grammar holds.
      arguments: JSON.stringify(u.input ?? {}),
    },
  }));
}

async function anthropicChat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('anthropic-chat: apiKey required');
  if (!opts.model) throw new Error('anthropic-chat: model required');

  const { system, systemBlocks, rest } = splitSystemAndMessages(opts.messages);

  // Apply cache_control markers. Anthropic enforces a hard cap of 4
  // breakpoints per request — we set at most 2 from opts.cacheControl
  // (system + last user) PLUS whatever per-block markers the caller
  // pre-emitted via array system content. The buildChatMessages helper
  // typically emits 2 system blocks (persona + digest), each with its
  // own cache_control — leaving headroom under the cap.
  const cacheControl = opts.cacheControl;
  let systemField: AnthropicSystemField | undefined;
  if (systemBlocks.length > 0) {
    // Caller pre-segmented + marked: use the blocks verbatim. Honour
    // cacheControl.systemPrompt by ensuring the LAST block carries an
    // ephemeral marker if none of the blocks do already.
    const hasAnyMarker = systemBlocks.some((b) => b.cache_control);
    if (cacheControl?.systemPrompt && !hasAnyMarker) {
      const lastBlock = systemBlocks[systemBlocks.length - 1]!;
      systemBlocks[systemBlocks.length - 1] = {
        ...lastBlock,
        cache_control: { type: 'ephemeral' },
      };
    }
    systemField = systemBlocks;
  } else if (system) {
    systemField = cacheControl?.systemPrompt
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  } else {
    systemField = undefined;
  }
  const lastUserIdx = cacheControl?.lastUserMessage ? lastUserIndex(rest) : -1;
  const messagesField: AnthropicMessage[] = rest.map((m, idx) => {
    if (idx !== lastUserIdx) return m;
    // The lastUser marker only attaches to a plain-string user message;
    // a user message that's already a tool_result block array is left
    // alone (cache_control on tool_result blocks isn't supported the
    // same way, and tool-loop calls have their own cache shape via
    // the system block).
    if (typeof m.content !== 'string') return m;
    return {
      role: m.role,
      content: [
        {
          type: 'text',
          text: m.content,
          cache_control: { type: 'ephemeral' },
        },
      ],
    };
  });

  const tools = buildAnthropicTools(opts);

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: messagesField,
    // max_tokens is REQUIRED on the Messages API. Default to a sane
    // ceiling; callers override via opts.maxTokens.
    max_tokens: opts.maxTokens ?? 4096,
    ...(systemField !== undefined ? { system: systemField } : {}),
    ...(tools ? { tools } : {}),
    // Anthropic's tool_choice supports 'auto' (default) and 'any' (force
    // some tool). We map our 'auto'/'none' carefully:
    //   - 'auto' is the default → omit the field
    //   - 'none' has no direct Anthropic equivalent → omit tools instead.
    // The tool_choice translation needed here today is therefore none.
    ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
    ...(typeof opts.topP === 'number' ? { top_p: opts.topP } : {}),
    ...(opts.extra ?? {}),
  };

  // 'none' tool choice: drop the tools field so the model can't call.
  if (opts.toolChoice === 'none' && tools) {
    delete body.tools;
  }

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
  // Response shape: content is an array of blocks; collect every text
  // block's text (the model can split narrative across multiple text
  // blocks when tool_use blocks interleave).
  const textBlocks = parsed.content.filter(
    (c): c is { type: 'text'; text: string } => c.type === 'text',
  );
  const text = textBlocks.map((b) => b.text).join('');
  const toolCalls = extractAnthropicToolCalls(parsed);
  return {
    text: text.trim(),
    model: parsed.model || opts.model,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    tokensIn: parsed.usage?.input_tokens,
    tokensOut: parsed.usage?.output_tokens,
    cacheReadTokens: parsed.usage?.cache_read_input_tokens,
    cacheWriteTokens: parsed.usage?.cache_creation_input_tokens,
  };
}

function lastUserIndex(messages: AnthropicMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === 'user') return i;
  }
  return -1;
}

/** Translate an OpenAI-shape image_url (which may be a data URL or a
 *  fetchable URL) into Anthropic's content block shape. Returns null
 *  for shapes we can't translate (kept defensive: the responder
 *  shouldn't emit those, but a malformed url shouldn't take down the
 *  request). */
function toAnthropicImageBlock(url: string): AnthropicImageBlock | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  // Data URL: split into media_type + base64 data.
  const dataMatch = /^data:([^;,]+);base64,(.+)$/.exec(url);
  if (dataMatch) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataMatch[1]!,
        data: dataMatch[2]!,
      },
    };
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
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
