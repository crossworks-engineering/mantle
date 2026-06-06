/**
 * OpenRouter chat adapter.
 *
 * Wraps the `@openrouter/sdk` chat completions call in the
 * ChatDispatcher contract so the prod chat path can flow through the
 * adapter registry like every other provider — closing the asymmetry
 * called out in §3.3 footnote ¹ of docs/ai-workers.md.
 *
 * Why the SDK and not a raw fetch:
 *   - OR's SDK already encodes the chat-request zod schema, the usage
 *     response shape (incl. promptTokensDetails for cache hits +
 *     `cost` for actual-charge billing), and the streaming/tool-call
 *     boundary. Re-implementing that surface with `fetch` would be a
 *     ~300 LOC duplication for no real win.
 *   - The SDK type `ChatUsage` carries cache_read / cache_write tokens
 *     directly — we round-trip those onto `ChatResult.cacheReadTokens` /
 *     `cacheWriteTokens` so cost dashboards stay accurate after the
 *     migration off direct SDK calls.
 *
 * Discovery: GET `/api/v1/models` is keyless on OR — we hit it without
 * needing the user's key. Soft-fails to the curated static catalog if
 * the call errors so the worker form still has options.
 *
 * cacheControl translation: OR honours Anthropic-style `cache_control:
 * { type: 'ephemeral' }` markers on content blocks and passes them
 * through to the underlying provider. We emit the same content-block
 * wrap as the anthropic-chat adapter when `opts.cacheControl` is set —
 * non-cache-aware downstream models harmlessly ignore the marker.
 */

import { OpenRouter } from '@openrouter/sdk';
import { OpenRouterError } from '@openrouter/sdk/models/errors';
import type {
  ChatCacheControl,
  ChatDispatcher,
  ChatModelInfo,
  ChatOptions,
  ChatResult,
  ChatToolCall,
} from './types';
import type { DiscoveryResult } from '../discover';
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_CHAT_MODELS,
} from '../catalogs/openrouter';

/** Text content block. Used for messages that need a cache_control
 *  marker (the array form is required — markers hang off the block,
 *  not the message). */
type OrChatTextBlock = {
  type: 'text';
  text: string;
  cacheControl?: { type: 'ephemeral' };
};

/** Image content block. OR's SDK accepts the OpenAI-shape image_url
 *  block (camelCase imageUrl on the typed input; snake_case image_url
 *  on the wire). The detail flag tunes how much vision compute the
 *  model spends per image. */
type OrChatImageBlock = {
  type: 'image_url';
  imageUrl: { url: string; detail?: 'auto' | 'low' | 'high' };
};

/** Mirror of the OR SDK's chat message union, narrowed to what we
 *  emit. The SDK accepts a wider shape (audio, etc.); we only build
 *  the slice the runtime uses. */
type OrChatMessage =
  | { role: 'system'; content: string | OrChatTextBlock[] }
  | {
      role: 'user';
      content: string | Array<OrChatTextBlock | OrChatImageBlock>;
    }
  | {
      role: 'assistant';
      content: string | null;
      toolCalls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; toolCallId: string; content: string };

/** Find the index of the final user-role message — the spot we attach
 *  the lastUserMessage cache marker to (when requested). */
function lastUserIndex(messages: ChatOptions['messages']): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'user') return i;
  }
  return -1;
}

/** Find the index of the final system-role message — the spot the
 *  `cacheControl.systemPrompt: true` marker attaches to (when the caller
 *  hasn't already pre-emitted any per-block markers). */
function lastSystemIndex(messages: ChatOptions['messages']): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'system') return i;
  }
  return -1;
}

/** Does any system message in the input already carry a per-block
 *  cache_control marker? When yes, the caller has pre-segmented the
 *  cacheable prefix — we must NOT add a second marker per the Anthropic
 *  4-breakpoint cap (mirrors anthropic-chat.ts behaviour). */
function anySystemHasMarker(messages: ChatOptions['messages']): boolean {
  for (const m of messages) {
    if (m.role !== 'system') continue;
    if (typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.cacheControl) return true;
    }
  }
  return false;
}

/** Convert ChatOptions.messages → OR SDK message shape, applying
 *  cache_control markers when the caller asked for them. Handles both
 *  the simple shape (chat-shaped workers, 3a) and the wider tool-loop
 *  shape (3b) carrying assistant.toolCalls and tool messages. */
function buildMessages(
  messages: ChatOptions['messages'],
  cacheControl?: ChatCacheControl,
): OrChatMessage[] {
  const lastUser = cacheControl?.lastUserMessage ? lastUserIndex(messages) : -1;
  // The `cacheControl.systemPrompt: true` flag means "mark the system
  // prefix as cacheable" — at most ONE breakpoint, not one per system
  // message. Anthropic caps cache_control at 4 markers per request; with
  // multiple system messages (persona + digests + content-hits + relations
  // + chunks) we used to fire a marker on every plain-string system, which
  // blew the cap whenever a few optional system blocks coexisted with the
  // caller's per-block markers on persona/digests.
  //
  // Rule (mirrors anthropic-chat.ts:361-368):
  //  - If the caller already pre-emitted any per-block markers in array-
  //    form system content → honour those, ignore systemPrompt flag.
  //  - Else if systemPrompt is set → attach exactly one ephemeral marker
  //    to the LAST system message (longest cacheable prefix).
  const callerPreMarked = anySystemHasMarker(messages);
  const systemPromptTarget =
    cacheControl?.systemPrompt && !callerPreMarked ? lastSystemIndex(messages) : -1;
  return messages.map((m, idx): OrChatMessage => {
    if (m.role === 'system') {
      // Three shapes:
      //  1. Plain string content + no cache control → passthrough.
      //  2. Plain string content + cacheControl.systemPrompt (and this is
      //     the last system message AND no per-block markers exist) →
      //     wrap in a single text block carrying the ephemeral marker.
      //  3. Array content (caller already pre-segmented + marked) →
      //     translate each block, preserving any per-block
      //     cache_control markers the caller emitted.
      if (typeof m.content === 'string') {
        if (idx === systemPromptTarget) {
          return {
            role: 'system',
            content: [
              {
                type: 'text',
                text: m.content,
                cacheControl: { type: 'ephemeral' },
              },
            ],
          };
        }
        return { role: 'system', content: m.content };
      }
      const blocks: OrChatTextBlock[] = m.content.map((p) => ({
        type: 'text',
        text: p.text,
        ...(p.cacheControl ? { cacheControl: p.cacheControl } : {}),
      }));
      return { role: 'system', content: blocks };
    }
    if (m.role === 'user') {
      // Two shapes: plain string content (most messages) and the
      // multi-modal array (vision-capable responder turns carrying
      // an image_url alongside the text). We translate both — and
      // when cacheControl.lastUserMessage is set on a string-content
      // message we wrap it in a text block to attach the marker.
      if (typeof m.content === 'string') {
        if (idx === lastUser) {
          return {
            role: 'user',
            content: [
              {
                type: 'text',
                text: m.content,
                cacheControl: { type: 'ephemeral' },
              },
            ],
          };
        }
        return { role: 'user', content: m.content };
      }
      // Array-shape content: pass each part through. text parts map
      // 1:1; image_url parts use the OR SDK's `imageUrl` camelCase.
      // Cache marker on the last user message attaches to the LAST
      // text block in the array (vision blocks don't carry markers).
      const parts: Array<OrChatTextBlock | OrChatImageBlock> = m.content.map(
        (p): OrChatTextBlock | OrChatImageBlock => {
          if (p.type === 'text') return { type: 'text', text: p.text };
          return {
            type: 'image_url',
            imageUrl: {
              url: p.imageUrl.url,
              ...(p.imageUrl.detail ? { detail: p.imageUrl.detail } : {}),
            },
          };
        },
      );
      if (idx === lastUser) {
        for (let i = parts.length - 1; i >= 0; i -= 1) {
          const p = parts[i]!;
          if (p.type === 'text') {
            parts[i] = { ...p, cacheControl: { type: 'ephemeral' } };
            break;
          }
        }
      }
      return { role: 'user', content: parts };
    }
    if (m.role === 'assistant') {
      // Tool-loop shape: content may be null when the model only
      // emitted toolCalls; toolCalls carry the function name + args
      // we re-send to pair with the next round's tool results.
      return {
        role: 'assistant',
        content: m.content as string | null,
        ...('toolCalls' in m && m.toolCalls
          ? { toolCalls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: c.function })) }
          : {}),
      };
    }
    // m.role === 'tool' — only present from the tool-loop path.
    return {
      role: 'tool',
      toolCallId: m.toolCallId,
      content: m.content,
    };
  });
}

/** Translate ChatOptions.tools (OpenAI-compat shape) → the OR SDK's
 *  tools input. The SDK uses camelCase on its typed surface; the
 *  outbound zod schema converts to snake_case on the wire. */
function buildTools(opts: ChatOptions): Array<Record<string, unknown>> | undefined {
  if (!opts.tools || opts.tools.length === 0) return undefined;
  return opts.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

/** Pull normalised tool calls off the OR response. OR mirrors the OpenAI
 *  shape — `choices[0].message.toolCalls` (camelCase on the SDK's
 *  typed surface) or `tool_calls` (snake_case on the raw JSON). */
function extractToolCalls(message: unknown): ChatToolCall[] | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const calls =
    (message as { toolCalls?: unknown }).toolCalls ??
    (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return undefined;
  return calls
    .map((c: unknown): ChatToolCall | null => {
      if (!c || typeof c !== 'object') return null;
      const id = (c as { id?: unknown }).id;
      const fn = (c as { function?: unknown }).function;
      if (typeof id !== 'string' || !fn || typeof fn !== 'object') return null;
      const name = (fn as { name?: unknown }).name;
      const args = (fn as { arguments?: unknown }).arguments;
      if (typeof name !== 'string') return null;
      return {
        id,
        type: 'function',
        function: {
          name,
          // OR's typed shape returns arguments already as a JSON string;
          // be defensive in case a route returns a parsed object.
          arguments:
            typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
      };
    })
    .filter((c): c is ChatToolCall => c !== null);
}

/** Extract the reply text from the OR SDK's chat completion response.
 *  `message.content` can be a plain string OR an array of content
 *  blocks; we walk both and concatenate text parts so callers get a
 *  single string. */
function extractReplyText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in c) {
          const text = (c as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** Re-throw an OR SDK error with the upstream provider detail folded into
 *  the message. The SDK's top-level `.message` is generic ("Provider
 *  returned error"); the real cause sits in `.error.message` (the OR
 *  envelope, surfaced from the underlying provider) and `.body` (the raw
 *  HTTP response). Keep the original error chained via `cause` so callers
 *  who type-check on `OpenRouterError` still get something useful. */
function enrichOpenRouterError(err: unknown, model: string): Error {
  if (!(err instanceof OpenRouterError)) {
    return err instanceof Error ? err : new Error(String(err));
  }
  const envelope = (err as { error?: { message?: string; code?: number; metadata?: unknown } }).error;
  const upstream = envelope?.message;
  const meta = envelope?.metadata;
  const status = err.statusCode;
  // Body is usually the same JSON the envelope was parsed from; include
  // a clipped slice when the envelope didn't have a message (some 5xx
  // routes return text/plain). Cap to keep trace rows readable.
  const bodyHint =
    !upstream && err.body
      ? ` body=${err.body.slice(0, 400)}`
      : '';
  const metaHint =
    meta && typeof meta === 'object'
      ? ` metadata=${JSON.stringify(meta).slice(0, 400)}`
      : '';
  const wrapped = new Error(
    `openrouter-chat ${status} on ${model}: ${upstream ?? err.message}${metaHint}${bodyHint}`,
    { cause: err },
  );
  wrapped.name = err.name;
  return wrapped;
}

async function openrouterChat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('openrouter-chat: apiKey required');
  if (!opts.model) throw new Error('openrouter-chat: model required');

  const client = new OpenRouter({
    apiKey: opts.apiKey,
    // Identifiers OR shows on its dashboard for traffic attribution.
    // Kept consistent with the existing direct-SDK call sites in
    // apps/agent so OR sees the same fingerprint pre- and post-migration.
    httpReferer: 'https://mantle.crossworks.network',
    appTitle: 'Mantle',
  });

  const messages = buildMessages(opts.messages, opts.cacheControl);
  const tools = buildTools(opts);

  // DEBUG: log cache_control marker count on every send so we can tell whether
  // the fix is on the path that's actually executing. Will be removed once
  // Saskia's first DM lands. v0.20.20+ should print "markers=2" or "markers=3".
  if (opts.model.startsWith('anthropic/')) {
    let markers = 0;
    const markerLocations: string[] = [];
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i]!;
      const c = (m as { content?: unknown }).content;
      if (Array.isArray(c)) {
        c.forEach((b: unknown, j: number) => {
          const cc = (b as { cacheControl?: unknown; cache_control?: unknown });
          if (cc.cacheControl || cc.cache_control) {
            markers += 1;
            markerLocations.push(`msg[${i}].role=${(m as { role?: string }).role}.block[${j}]`);
          }
        });
      }
    }
    console.log(
      `[openrouter-chat] cache_control markers=${markers} locations=${JSON.stringify(markerLocations)} ` +
      `cacheControl=${JSON.stringify(opts.cacheControl ?? null)} model=${opts.model}`,
    );
  }

  const chatRequest = {
    model: opts.model,
    messages,
    ...(tools ? { tools } : {}),
    ...(opts.toolChoice ? { toolChoice: opts.toolChoice } : {}),
    ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
    ...(typeof opts.maxTokens === 'number' ? { maxTokens: opts.maxTokens } : {}),
    ...(typeof opts.topP === 'number' ? { topP: opts.topP } : {}),
    ...(opts.extra ?? {}),
  };
  // Single typed boundary: our structurally-clean builders (OrChatMessage /
  // tool records) aren't nominally assignable to the SDK's zod-generated input
  // types, so we bridge once here rather than scattering `as unknown as` over
  // individual fields. Behaviour is unchanged; the laundering is one line.
  let result: Awaited<ReturnType<typeof client.chat.send>>;
  try {
    result = await client.chat.send({
      chatRequest: chatRequest as unknown as Parameters<
        typeof client.chat.send
      >[0]['chatRequest'],
    });
  } catch (err) {
    // The SDK throws subclasses of OpenRouterError on non-2xx responses.
    // Its top-level `message` is the generic OR description ("Provider
    // returned error", "Unauthorized", etc.) — the actionable upstream
    // detail lives in `.error.message` / `.error.metadata` (the OR
    // envelope), and the raw HTTP body lives on `.body`. Unpack so the
    // trace + console show what actually failed.
    throw enrichOpenRouterError(err, opts.model);
  }
  if (!('choices' in result)) {
    throw new Error(
      'openrouter-chat: unexpected streaming response (no `choices`)',
    );
  }

  const choice = result.choices?.[0];
  const text = extractReplyText(choice?.message).trim();
  const toolCalls = extractToolCalls(choice?.message);
  const usage = result.usage;
  // The SDK's `cost` field is a USD number when OR reports it (always
  // for routes where OR has direct billing visibility). We expose it
  // verbatim — the trace recorder converts to micro-USD and prefers
  // this over the static price table.
  const reportedCostUsd =
    usage?.cost != null && Number.isFinite(usage.cost) ? usage.cost : undefined;

  return {
    text,
    model: (result as { model?: string }).model || opts.model,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    tokensIn: usage?.promptTokens,
    tokensOut: usage?.completionTokens,
    cacheReadTokens: usage?.promptTokensDetails?.cachedTokens ?? undefined,
    cacheWriteTokens: usage?.promptTokensDetails?.cacheWriteTokens ?? undefined,
    reportedCostUsd,
  };
}

type OrListModelsResponse = {
  data?: Array<{
    id: string;
    name?: string;
    description?: string;
    context_length?: number;
    top_provider?: { context_length?: number };
    pricing?: { prompt?: string; completion?: string };
    architecture?: { modality?: string; input_modalities?: string[] };
  }>;
};

/** Decimal-string price → USD per 1M tokens. OR's pricing fields are
 *  per-token strings ("0.000003"). Multiply by 1M and round to 4dp
 *  for display. */
function perMillion(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 1_000_000 * 10_000) / 10_000;
}

async function openrouterDiscover(
  _apiKey: string,
): Promise<DiscoveryResult<ChatModelInfo>> {
  // OR's /api/v1/models is keyless — we don't need the user's key
  // (the underscore on the param). We pass it anyway in case OR ever
  // starts gating; sending an Authorization header against a keyless
  // endpoint is a no-op.
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      headers: _apiKey ? { Authorization: `Bearer ${_apiKey}` } : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        available: [...OPENROUTER_CHAT_MODELS],
        filtered: false,
        error: `openrouter /v1/models ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const parsed = (await res.json()) as OrListModelsResponse;
    const models = parsed.data ?? [];
    // Filter to chat-shaped models (drop embeddings, image-gen). OR's
    // catalog has a modality field on architecture; presence of
    // 'text' input + 'text' output = chat.
    const chatModels: ChatModelInfo[] = models
      .filter((m) => {
        const inputs = m.architecture?.input_modalities ?? [];
        // If no modality info, assume chat (most entries are chat).
        if (inputs.length === 0) return true;
        return inputs.includes('text');
      })
      // Skip image-output-only routes (they live in the kind='image' bucket).
      .filter((m) => !/(image|stable-diffusion|flux|dall-e)/i.test(m.id))
      .map((m) => ({
        id: m.id,
        label: m.name || m.id,
        description: m.description || `OpenRouter route: ${m.id}`,
        contextTokens: m.top_provider?.context_length ?? m.context_length,
        inputPricePer1M: perMillion(m.pricing?.prompt),
        outputPricePer1M: perMillion(m.pricing?.completion),
      }));
    return {
      // Discovery returned the live list — that's the authoritative
      // answer. Fall back to the static catalog only when discovery
      // somehow returned zero (network glitch the response status
      // didn't catch).
      available: chatModels.length > 0 ? chatModels : [...OPENROUTER_CHAT_MODELS],
      filtered: chatModels.length > 0,
      error: null,
    };
  } catch (err) {
    return {
      available: [...OPENROUTER_CHAT_MODELS],
      filtered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const openrouterChatAdapter: ChatDispatcher = {
  providerId: 'openrouter',
  adapterName: 'openrouter-chat',
  chat: openrouterChat,
  discoverModels: openrouterDiscover,
  staticCatalog: () => OPENROUTER_CHAT_MODELS,
};
