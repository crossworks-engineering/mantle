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
  ChatStreamDelta,
  ChatStreamSink,
  ChatToolCall,
  ReasoningDetail,
} from './types';
import type { DiscoveryResult } from '../discover';
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_CHAT_MODELS,
} from '../catalogs/openrouter';
import { DEFAULT_MAX_RETRIES, isEmptyJsonBodyError } from './retry';
import { StreamingThinkScrubber } from './think-scrubber';
import { ReasoningDetailsAccumulator, normalizeReasoningDetails } from './reasoning-accum';

// Backoff for the empty-body retry below — mirrors retry.ts's full-jitter shape.
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

/** OpenRouter's unified `reasoning` param from our `thinkingBudget`. OR routes
 *  `max_tokens` to the upstream provider's thinking budget (Anthropic) or maps
 *  it to an effort tier (OpenAI o-series); models without a reasoning mode
 *  ignore it. Returns undefined when no budget is set so we omit the field. */
function openRouterReasoning(opts: ChatOptions): { maxTokens: number } | undefined {
  const budget =
    typeof opts.thinkingBudget === 'number' && opts.thinkingBudget > 0 ? Math.floor(opts.thinkingBudget) : 0;
  return budget > 0 ? { maxTokens: budget } : undefined;
}

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
      /** Signed reasoning blocks echoed back so a thinking-then-tool_use turn is
       *  accepted upstream (camelCase here; the SDK emits `reasoning_details`). */
      reasoningDetails?: ReasoningDetail[];
    }
  | { role: 'tool'; toolCallId: string; content: string | OrChatTextBlock[] };

/** Find the index of the final message that can carry the moving "tail"
 *  cache marker. In a tool loop the genuinely-last message is a `tool`
 *  result: OpenRouter uses the OpenAI shape, so tool results stay as
 *  `role:'tool'` rather than folding into a user turn (the way
 *  anthropic-chat.ts coalesces them). Anchoring the marker on the last
 *  *user* message therefore pins it to the original question, so it never
 *  advances and the growing tool-result tail is re-sent uncached every
 *  round (the cost bug in docs/audit-chat-cost-2026-06-07.md). We instead
 *  mark the last user-OR-tool message so the breakpoint advances with the
 *  loop; Anthropic's incremental (20-block lookback) cache then reads the
 *  whole prefix-so-far up to and including the marked tail block. */
function lastMarkableIndex(messages: ChatOptions['messages']): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = messages[i]!.role;
    if (role === 'user' || role === 'tool') return i;
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
  const tailIdx = cacheControl?.lastUserMessage ? lastMarkableIndex(messages) : -1;
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
        if (idx === tailIdx) {
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
      if (idx === tailIdx) {
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
        // Echo signed reasoning blocks back unchanged so Anthropic accepts a turn
        // that paired thinking with tool_use (it 400s if the block is missing).
        ...('reasoningDetails' in m && m.reasoningDetails && m.reasoningDetails.length > 0
          ? { reasoningDetails: m.reasoningDetails }
          : {}),
      };
    }
    // m.role === 'tool' — only present from the tool-loop path. When this
    // is the tail message (the latest tool result in the loop), wrap the
    // content in a text block carrying the ephemeral marker so the cache
    // breakpoint advances past the accumulating tool-result tail. OR
    // forwards cache_control on tool messages to Anthropic, which caches
    // up to and including this block (see the audit doc's finding b).
    if (idx === tailIdx) {
      return {
        role: 'tool',
        toolCallId: m.toolCallId,
        content: [
          {
            type: 'text',
            text: m.content,
            cacheControl: { type: 'ephemeral' },
          },
        ],
      };
    }
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

/** Pull the signed reasoning blocks off a one-shot OR response message
 *  (`reasoningDetails` camelCase / `reasoning_details` snake), normalised to
 *  our shape so the tool loop can echo them back next round. */
function extractReasoningDetails(message: unknown): ReasoningDetail[] | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const raw =
    (message as { reasoningDetails?: unknown }).reasoningDetails ??
    (message as { reasoning_details?: unknown }).reasoning_details;
  return normalizeReasoningDetails(raw);
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
function enrichOpenRouterError(err: unknown, model: string, elapsedMs?: number): Error {
  // Empty/truncated 2xx body the SDK couldn't parse — an upstream timeout or
  // dropped connection surfaces here as a context-free `SyntaxError: Unexpected
  // end of JSON input` with no status. Wrap it so the trace shows what actually
  // happened, naming the model + how long the call stalled before the body died.
  if (isEmptyJsonBodyError(err)) {
    const took = elapsedMs != null ? ` after ${(elapsedMs / 1000).toFixed(1)}s` : '';
    const wrapped = new Error(
      `openrouter-chat: empty or truncated response from ${model}${took} — likely an upstream timeout or dropped connection`,
      { cause: err },
    );
    wrapped.name = 'OpenRouterEmptyResponseError';
    return wrapped;
  }
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
  const reasoningParam = openRouterReasoning(opts);

  const chatRequest = {
    model: opts.model,
    messages,
    ...(tools ? { tools } : {}),
    // Only send tool_choice when tools are actually present. xAI/Grok rejects a
    // tool_choice with no tools ("A tool_choice was set but no tools were
    // specified" → 400) — which is exactly the force-final pass (toolChoice
    // 'none', tools dropped). Without tools there's nothing to choose anyway, so
    // omitting it forces a text answer on every provider. (Anthropic tolerated
    // it; xAI didn't — this is the crash that errored a $0.73 turn.)
    ...(opts.toolChoice && tools ? { toolChoice: opts.toolChoice } : {}),
    ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
    ...(typeof opts.maxTokens === 'number' ? { maxTokens: opts.maxTokens } : {}),
    ...(typeof opts.topP === 'number' ? { topP: opts.topP } : {}),
    ...(reasoningParam ? { reasoning: reasoningParam } : {}),
    ...(opts.extra ?? {}),
  };
  // Single typed boundary: our structurally-clean builders (OrChatMessage /
  // tool records) aren't nominally assignable to the SDK's zod-generated input
  // types, so we bridge once here rather than scattering `as unknown as` over
  // individual fields. Behaviour is unchanged; the laundering is one line.
  const sendOnce = () =>
    client.chat.send({
      chatRequest: chatRequest as unknown as Parameters<
        typeof client.chat.send
      >[0]['chatRequest'],
    });

  // The SDK retries HTTP-level transients (429/5xx/network) itself, which is why
  // the registry does NOT wrap this adapter in withChatRetry (double-retrying
  // would compound attempt counts). The ONE transient the SDK does NOT cover is
  // an empty/truncated 2xx body: it reads the body, `JSON.parse` throws a bare
  // SyntaxError, and the whole turn dies — the exact failure that killed a
  // 16-step assistant turn after a 34s upstream stall. Retry THAT case (only)
  // here, with full-jitter backoff, then surface a contextful error.
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof client.chat.send>>;
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = await sendOnce();
      break;
    } catch (err) {
      if (isEmptyJsonBodyError(err) && attempt < maxRetries) {
        const delay = Math.round(
          Math.random() *
            Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt),
        );
        console.warn(
          `[openrouter-chat] ${opts.model}: empty/truncated response — ` +
            `retry ${attempt + 1}/${maxRetries} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      // Non-2xx → OpenRouterError; its top-level `message` is the generic OR
      // description ("Provider returned error", "Unauthorized") — the actionable
      // upstream detail lives in `.error.message` / `.error.metadata` and the raw
      // body on `.body`. An exhausted empty-body retry → a contextful wrap. Both
      // go through enrichOpenRouterError so the trace shows what actually failed.
      throw enrichOpenRouterError(err, opts.model, Date.now() - startedAt);
    }
  }
  if (!('choices' in result)) {
    throw new Error(
      'openrouter-chat: unexpected streaming response (no `choices`)',
    );
  }

  const choice = result.choices?.[0];
  const text = extractReplyText(choice?.message).trim();
  const toolCalls = extractToolCalls(choice?.message);
  const reasoningDetails = extractReasoningDetails(choice?.message);
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
    ...(reasoningDetails ? { reasoningDetails } : {}),
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
  apiKey: string,
): Promise<DiscoveryResult<ChatModelInfo>> {
  // OR's /api/v1/models is PUBLIC (returns 200 even with a bogus key), so the
  // catalog fetch alone is NOT an auth probe — probeApiKey relying on it would
  // pass any garbage key. When a key is supplied, validate it first against
  // GET /api/v1/key, which does check auth (401 on a bad key). A network
  // hiccup on that endpoint doesn't fail discovery — only an explicit
  // 401/403 does, so catalog browsing keeps working offline-ish.
  if (apiKey) {
    try {
      const auth = await fetch(`${OPENROUTER_BASE_URL}/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (auth.status === 401 || auth.status === 403) {
        return {
          available: [],
          filtered: false,
          error: `OpenRouter rejected the key (${auth.status}) — check it at openrouter.ai/keys.`,
        };
      }
    } catch {
      /* auth endpoint unreachable — fall through to the catalog fetch */
    }
  }
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
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

/** Loose shape of one OpenRouter SSE chunk (the SDK parses to camelCase). Kept
 *  local + defensive (snake_case fallbacks) so this adapter doesn't depend on the
 *  SDK's internal streaming model exports. */
type OrStreamChunk = {
  model?: string;
  error?: { code?: number; message?: string };
  usage?: {
    promptTokens?: number;
    prompt_tokens?: number;
    completionTokens?: number;
    completion_tokens?: number;
    cost?: number;
    promptTokensDetails?: { cachedTokens?: number; cacheWriteTokens?: number };
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
  choices?: Array<{
    finishReason?: string | null;
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoningDetails?: OrReasoningDetailFragment[];
      reasoning_details?: OrReasoningDetailFragment[];
      toolCalls?: OrStreamToolCallFragment[];
      tool_calls?: OrStreamToolCallFragment[];
    };
  }>;
};
/** One streamed `reasoning_details` fragment. OpenRouter sends these in pieces,
 *  keyed by `index`; text accumulates and the `signature` lands once per block.
 *  We carry the assembled blocks back verbatim on the next request so the
 *  upstream provider (Anthropic) accepts a thinking-then-tool_use turn. */
type OrReasoningDetailFragment = {
  type?: string;
  index?: number;
  text?: string | null;
  data?: string | null;
  summary?: string | null;
  signature?: string | null;
  format?: string | null;
  id?: string | null;
};
type OrStreamToolCallFragment = {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

/**
 * Streaming counterpart of `openrouterChat`. Sets `stream: true` (and
 * `usage: { include: true }` so the terminal chunk still carries token counts +
 * `cost` for `recordChatUsage`), iterates the SDK's `EventStream`, fires the
 * caller's `onDelta` per visible text / reasoning chunk, accumulates tool-call
 * argument FRAGMENTS by index, and resolves to the same `ChatResult` shape
 * `openrouterChat` returns. The deltas are decoration; this returned result is the
 * durable answer.
 *
 * No empty-body retry here (unlike the one-shot path): a stream that fails mid-
 * flight can't be cleanly resumed, so we surface the error and let the caller
 * fall back to the one-shot `chat()` on the backup route.
 */
async function openrouterChatStream(
  opts: ChatOptions,
  onDelta: ChatStreamSink,
): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('openrouter-chat: apiKey required');
  if (!opts.model) throw new Error('openrouter-chat: model required');

  const client = new OpenRouter({
    apiKey: opts.apiKey,
    httpReferer: 'https://mantle.crossworks.network',
    appTitle: 'Mantle',
  });

  const messages = buildMessages(opts.messages, opts.cacheControl);
  const tools = buildTools(opts);
  const reasoningParam = openRouterReasoning(opts);
  const chatRequest = {
    model: opts.model,
    messages,
    stream: true,
    // Ask OR to fold the usage block into the final chunk — without this a
    // streamed call reports no tokens and cost tracking silently breaks.
    usage: { include: true },
    ...(tools ? { tools } : {}),
    ...(opts.toolChoice && tools ? { toolChoice: opts.toolChoice } : {}),
    ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
    ...(typeof opts.maxTokens === 'number' ? { maxTokens: opts.maxTokens } : {}),
    ...(typeof opts.topP === 'number' ? { topP: opts.topP } : {}),
    ...(reasoningParam ? { reasoning: reasoningParam } : {}),
    ...(opts.extra ?? {}),
  };

  const startedAt = Date.now();
  // The user already hit Stop before we even sent — don't spend the request.
  if (opts.signal?.aborted) {
    return { text: '', model: opts.model };
  }
  let sent: AsyncIterable<OrStreamChunk>;
  try {
    sent = (await client.chat.send(
      {
        chatRequest: chatRequest as unknown as Parameters<typeof client.chat.send>[0]['chatRequest'],
      },
      // Thread the cancellation signal into the underlying fetch so a Stop aborts
      // the HTTP stream — halting upstream token generation, not just our reading.
      ...(opts.signal ? [{ signal: opts.signal }] : []),
    )) as unknown as AsyncIterable<OrStreamChunk>;
  } catch (err) {
    if (opts.signal?.aborted) return { text: '', model: opts.model };
    throw enrichOpenRouterError(err, opts.model, Date.now() - startedAt);
  }

  let text = '';
  let reasoning = '';
  let model = opts.model;
  let usage: OrStreamChunk['usage'];
  // Tool-call fragments accumulate by index: id+name land first, arguments arrive
  // in pieces. Assembled into ChatToolCall[] after the stream closes.
  const toolAccum = new Map<number, { id: string; name: string; args: string }>();
  // OpenRouter surfaces reasoning in its typed `reasoning` field, but a model can
  // still inline <think> in content (some open routes do) — scrub it defensively.
  const scrubber = new StreamingThinkScrubber();
  // Signed reasoning blocks, reassembled from streamed fragments, so the tool
  // loop can echo them back on the next request (Anthropic 400s a thinking-then-
  // tool_use turn that omits them). See ReasoningDetailsAccumulator.
  const reasoningDetails = new ReasoningDetailsAccumulator();

  try {
    for await (const chunk of sent) {
      // User hit Stop — stop reading and keep whatever streamed so far. Breaking
      // the iterator also closes the underlying stream (belt to the fetch signal).
      if (opts.signal?.aborted) break;
      if (chunk.error) {
        throw new Error(
          `openrouter-chat stream error ${chunk.error.code ?? ''}: ${chunk.error.message ?? 'unknown'}`.trim(),
        );
      }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        const visible = scrubber.feed(delta.content);
        if (visible) {
          text += visible;
          safeDelta(onDelta, { type: 'text', text: visible });
        }
      }
      if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
        reasoning += delta.reasoning;
        safeDelta(onDelta, { type: 'reasoning', text: delta.reasoning });
      }
      reasoningDetails.add(delta.reasoningDetails ?? delta.reasoning_details);
      const frags = delta.toolCalls ?? delta.tool_calls;
      if (Array.isArray(frags)) {
        for (const f of frags) {
          if (typeof f?.index !== 'number') continue;
          const cur = toolAccum.get(f.index) ?? { id: '', name: '', args: '' };
          if (f.id) cur.id = f.id;
          if (f.function?.name) cur.name = f.function.name;
          if (typeof f.function?.arguments === 'string') cur.args += f.function.arguments;
          toolAccum.set(f.index, cur);
        }
      }
    }
  } catch (err) {
    // A user Stop aborts the underlying fetch, which surfaces here as an
    // AbortError — that's not a failure: fall through and return the partial
    // reply assembled so far. Any other error is a real stream fault.
    if (!opts.signal?.aborted) throw enrichOpenRouterError(err, opts.model, Date.now() - startedAt);
  }

  // Flush any partial tag held at the boundary (discarded if a block was left
  // open; otherwise the held prose surfaces).
  const tail = scrubber.flush();
  if (tail) {
    text += tail;
    safeDelta(onDelta, { type: 'text', text: tail });
  }

  // Stopped: return just the visible text assembled so far (drop any half-formed
  // tool-call fragments, which would dispatch a malformed tool). The turn loop
  // sees text + no tools and finalizes it as the — partial — answer.
  if (opts.signal?.aborted) {
    return {
      text: text.trim(),
      model,
      tokensIn: usage?.promptTokens ?? usage?.prompt_tokens,
      tokensOut: usage?.completionTokens ?? usage?.completion_tokens,
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

  const cost = usage?.cost;
  const reportedCostUsd = cost != null && Number.isFinite(cost) ? cost : undefined;
  const cacheRead =
    usage?.promptTokensDetails?.cachedTokens ?? usage?.prompt_tokens_details?.cached_tokens;
  const cacheWrite =
    usage?.promptTokensDetails?.cacheWriteTokens ?? usage?.prompt_tokens_details?.cache_write_tokens;

  const details = reasoningDetails.result();
  return {
    text: text.trim(),
    model,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    tokensIn: usage?.promptTokens ?? usage?.prompt_tokens,
    tokensOut: usage?.completionTokens ?? usage?.completion_tokens,
    cacheReadTokens: cacheRead ?? undefined,
    cacheWriteTokens: cacheWrite ?? undefined,
    reportedCostUsd,
    ...(details ? { reasoningDetails: details } : {}),
  };
}

/** Call the delta sink without ever letting it break the stream loop. */
function safeDelta(onDelta: ChatStreamSink, delta: ChatStreamDelta): void {
  try {
    onDelta(delta);
  } catch (err) {
    console.warn('[openrouter-chat] delta sink threw (ignored):', err instanceof Error ? err.message : err);
  }
}

export const openrouterChatAdapter: ChatDispatcher = {
  providerId: 'openrouter',
  adapterName: 'openrouter-chat',
  chat: openrouterChat,
  chatStream: openrouterChatStream,
  discoverModels: openrouterDiscover,
  staticCatalog: () => OPENROUTER_CHAT_MODELS,
};
