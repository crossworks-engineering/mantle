/**
 * EXPERIMENT — anthropic-chat reimplemented on `@ai-sdk/anthropic`.
 *
 * Not wired into the registry. It exists to answer one question with evidence
 * instead of opinion: can the Vercel AI SDK satisfy Mantle's ChatDispatcher
 * contract, and what does the request it emits look like next to the one our
 * hand-written adapter emits?
 *
 * Deliberately parallel rather than a replacement, so the SAME test suite can
 * run against both and the wire bodies can be diffed directly.
 *
 * SCOPE — now covers the two features that generated the painful commits:
 * streaming (text + reasoning deltas) and prompt-cache breakpoints. Still NOT
 * covered: discoverModels, staticCatalog, and the bespoke error enrichment /
 * empty-body retry. Those are catalogue and transport concerns the SDK doesn't
 * claim to own, and they stay ours either way.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText, jsonSchema, type ModelMessage, type ToolSet } from 'ai';
import type {
  ChatDispatcher,
  ChatOptions,
  ChatResult,
  ChatStreamSink,
  ChatToolCall,
  ThinkingEffort,
} from './types';
import { anthropicEffort } from './anthropic-chat';
import { wantGuardedThinking } from './thinking-guard';

/** The provider-options blob that marks a block as a cache breakpoint.
 *
 *  Typed inline because `ProviderOptions` is declared but NOT exported from
 *  `ai` — the type has no public name, so a consumer can only restate it. */
const CACHE_BREAKPOINT = {
  anthropic: { cacheControl: { type: 'ephemeral' as const } },
};

/**
 * Translate our message union into the SDK's.
 *
 * FRICTION 1 — `tool-result` requires `toolName`, but our `ChatToolMessage`
 * carries only `toolCallId`; the name lives on the assistant turn that
 * requested the call. So this is stateful: we walk forward building an id→name
 * map. Our own adapter needs no such bookkeeping, because Anthropic's wire
 * shape keys tool_result purely by id. The abstraction adds this, not removes it.
 *
 * FRICTION 2 — multi-block system prompts. Our responder splits the system
 * prompt into persona + digest, each independently cache-marked. The SDK's
 * `instructions` is a single string, which would flatten them and lose the
 * per-block breakpoints. The way to keep them is `allowSystemInMessages` plus
 * one system message per block, each carrying its own providerOptions.
 */
function toModelMessages(
  messages: ChatOptions['messages'],
  cache: ChatOptions['cacheControl'],
): ModelMessage[] {
  const toolNameById = new Map<string, string>();
  const out: ModelMessage[] = [];

  // Index of the last user message, so the moving breakpoint lands on it.
  const lastUserIdx = cache?.lastUserMessage ? messages.map((m) => m.role).lastIndexOf('user') : -1;

  messages.forEach((m, i) => {
    if (m.role === 'system') {
      const blocks =
        typeof m.content === 'string'
          ? [{ text: m.content, mark: cache?.systemPrompt === true }]
          : m.content.map((p) => ({ text: p.text, mark: p.cacheControl !== undefined }));
      for (const b of blocks) {
        out.push({
          role: 'system',
          content: b.text,
          ...(b.mark ? { providerOptions: CACHE_BREAKPOINT } : {}),
        });
      }
      return;
    }

    if (m.role === 'user') {
      const mark = i === lastUserIdx;
      out.push({
        role: 'user',
        content:
          typeof m.content === 'string'
            ? [
                {
                  type: 'text',
                  text: m.content,
                  ...(mark ? { providerOptions: CACHE_BREAKPOINT } : {}),
                },
              ]
            : m.content.map((p, j, arr) =>
                p.type === 'text'
                  ? ({
                      type: 'text',
                      text: p.text,
                      // Mark the LAST block of the marked message — the marker
                      // hangs off a block, and only the final one delimits the
                      // whole prefix.
                      ...(mark && j === arr.length - 1
                        ? { providerOptions: CACHE_BREAKPOINT }
                        : {}),
                    } as const)
                  : ({ type: 'image', image: new URL(p.imageUrl.url) } as const),
              ),
      });
      return;
    }

    if (m.role === 'assistant') {
      for (const tc of m.toolCalls ?? []) toolNameById.set(tc.id, tc.function.name);
      const parts: Extract<ModelMessage, { role: 'assistant' }>['content'] = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        parts.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: safeParse(tc.function.arguments),
        });
      }
      out.push({ role: 'assistant', content: parts });
      return;
    }

    out.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: m.toolCallId,
          toolName: toolNameById.get(m.toolCallId) ?? 'unknown',
          output: { type: 'text', value: m.content },
        },
      ],
    });
  });

  return out;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function toToolSet(opts: ChatOptions): ToolSet | undefined {
  if (!opts.tools?.length) return undefined;
  const set: ToolSet = {};
  for (const t of opts.tools) {
    // No `execute` — Mantle's tool-loop dispatches, so the SDK must hand the
    // call back rather than running it. Omitting execute is what stops the
    // built-in agent loop from taking over.
    set[t.function.name] = {
      description: t.function.description,
      inputSchema: jsonSchema(t.function.parameters),
    };
  }
  return set;
}

/** Everything both paths share, so streaming and one-shot can't drift. */
function buildArgs(opts: ChatOptions) {
  const anthropic = createAnthropic({ apiKey: opts.apiKey });
  const effort = anthropicEffort(opts.model, opts.thinkingEffort as ThinkingEffort | undefined);
  const wantThinking = wantGuardedThinking(opts);
  const tools = toToolSet(opts);

  return {
    model: anthropic(opts.model),
    messages: toModelMessages(opts.messages, opts.cacheControl),
    // Required: our system blocks ride in `messages` so each keeps its own
    // cache breakpoint. Without this the SDK rejects them.
    allowSystemInMessages: true,
    maxOutputTokens: opts.maxTokens ?? 4096,
    ...(tools ? { tools } : {}),
    ...(opts.signal ? { abortSignal: opts.signal } : {}),
    ...(typeof opts.maxRetries === 'number' ? { maxRetries: opts.maxRetries } : {}),
    ...(wantThinking
      ? {}
      : {
          ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
          ...(typeof opts.topP === 'number' ? { topP: opts.topP } : {}),
        }),
    providerOptions: {
      anthropic: {
        ...(wantThinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
        ...(effort ? { effort } : {}),
      },
    },
  };
}

type Usage = { inputTokens?: number; outputTokens?: number; inputTokenDetails?: unknown };

function toResult(
  model: string,
  text: string,
  rawToolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>,
  usage: Usage,
): ChatResult {
  const toolCalls: ChatToolCall[] = rawToolCalls.map((tc) => ({
    id: tc.toolCallId,
    type: 'function' as const,
    function: { name: tc.toolName, arguments: JSON.stringify(tc.input) },
  }));
  const details = usage.inputTokenDetails as
    { cacheReadTokens?: number; cacheWriteTokens?: number } | undefined;

  return {
    text,
    model,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(usage.inputTokens !== undefined ? { tokensIn: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { tokensOut: usage.outputTokens } : {}),
    ...(details?.cacheReadTokens !== undefined ? { cacheReadTokens: details.cacheReadTokens } : {}),
    ...(details?.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: details.cacheWriteTokens }
      : {}),
  };
}

async function chat(opts: ChatOptions): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('anthropic-chat-aisdk: apiKey required');
  if (!opts.model) throw new Error('anthropic-chat-aisdk: model required');
  const r = await generateText(buildArgs(opts));
  return toResult(opts.model, r.text, r.toolCalls, r.usage);
}

async function chatStream(opts: ChatOptions, onDelta: ChatStreamSink): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('anthropic-chat-aisdk: apiKey required');
  if (!opts.model) throw new Error('anthropic-chat-aisdk: model required');

  const r = streamText(buildArgs(opts));

  // `stream` is v7's rename of `fullStream` — the union carrying text AND
  // reasoning deltas. `textStream` alone would silently drop reasoning.
  //
  // TRAP: the delta payload is `.text` here. The LOW-LEVEL provider union
  // (LanguageModelV3StreamPart) spells the same field `.delta`, so both names
  // appear in the same .d.ts for the same concept. Reading the wrong one is a
  // type error rather than a silent drop — but only because the cast-free path
  // is typed; a stray `any` here would have shipped an empty stream.
  for await (const part of r.stream) {
    if (part.type === 'text-delta') onDelta({ type: 'text', text: part.text });
    else if (part.type === 'reasoning-delta') onDelta({ type: 'reasoning', text: part.text });
  }

  // Every accessor is a promise that settles once the stream drains, so the
  // resolved ChatResult is the same shape the one-shot path returns.
  return toResult(opts.model, await r.text, await r.toolCalls, await r.usage);
}

export const anthropicAiSdkChatAdapter: ChatDispatcher = {
  providerId: 'anthropic',
  adapterName: 'anthropic-chat-aisdk',
  chat,
  chatStream,
};
