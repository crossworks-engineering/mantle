/**
 * Multi-turn tool-call loop. Wraps a single chat-adapter call into an
 * iterative cycle:
 *
 *   1. send messages → assistant response
 *   2. if response.toolCalls present:
 *         append the assistant message,
 *         dispatch each tool locally,
 *         append a tool message per call,
 *         goto 1
 *      else return the text reply
 *
 * Each LLM round goes in a `step({kind: 'llm_call'})` so cost + tokens
 * roll into the parent trace. Each tool call gets its own
 * `step({kind: 'compute'})` so the reactflow visual shows the full
 * chain. Failures inside tool handlers don't kill the loop — they're
 * surfaced to the model as tool results so it can recover.
 *
 * Phase-3b note: dispatches through `getChatAdapter(provider).chat()`
 * instead of constructing the OpenRouter SDK inline. The adapter
 * normalises tool calls across providers (Anthropic tool_use blocks,
 * Google functionCall parts, OpenAI tool_calls[]) into a single shape
 * the loop iterates. cacheControl markers travel through ChatOptions
 * so the system block + last-user breakpoints fire on cache-aware
 * providers (Anthropic, OR-via-Anthropic).
 */

import { currentTrace, step } from '@mantle/tracing';
import {
  dispatchTool,
  getBuiltinRedactFields,
  redactArgsForLogging,
  resolveTool,
  resolveTools,
  processToolResultForModel,
  resolveResultHandling,
  type ResultHandlingConfig,
  type ToolCallRecord,
} from '@mantle/tools';
import { and, eq, sql } from 'drizzle-orm';
import { db, pendingToolCalls, type Tool, type AgentParams } from '@mantle/db';
import type { ToolArtifact } from '@mantle/tools';
import {
  getChatAdapter,
  type ChatDispatcher,
  type ChatToolDefinition,
} from '@mantle/voice';
import { recordChatUsage } from './llm-usage';
import type { ChatMessage } from './messages';
import { parseToolArgs } from './tool-args';

const DEFAULT_MAX_ITERATIONS = 6;

/** Process-lifetime cache of the resolved `read_result` tool row, keyed by
 *  owner. It's a stable seeded builtin, so resolving it once per owner avoids
 *  a per-turn DB query on the always-offer path. Misses aren't cached (so it
 *  picks up once seeding has run). */
const readResultToolByOwner = new Map<string, Tool>();

async function resolveReadResultTool(ownerId: string): Promise<Tool | null> {
  const cached = readResultToolByOwner.get(ownerId);
  if (cached) return cached;
  const row = await resolveTool(ownerId, 'read_result');
  if (row) readResultToolByOwner.set(ownerId, row);
  return row;
}

export type ToolLoopResult = {
  /** Final assistant text response (last turn's `content`). */
  reply: string;
  /** Full message chain after the loop completed. Includes every
   *  assistant + tool round. Caller can persist this if they want. */
  messages: ChatMessage[];
  /** Number of LLM round-trips (1 = no tool calls, just one response). */
  iterations: number;
  /** Per-tool-call telemetry. */
  toolCalls: ToolCallRecord[];
  /** Pending-call ids the loop queued during this run (one per
   *  requires_confirm tool the model asked for). Surface these to
   *  the operator so they can approve/reject at /pending. */
  pendingIds: string[];
  /** Sidecar artifacts the tools produced — audio bytes from a TTS
   *  call, image bytes from a generation, etc. The web /assistant
   *  surfaces these inline in the reply bubble; Telegram already
   *  delivers them through the tool's own send path and ignores this
   *  field. Empty array when no tools ran or none emitted artifacts. */
  artifacts: ToolArtifact[];
};

export type ToolLoopArgs = {
  /** Pre-resolved chat adapter for the agent's provider. Callers
   *  resolve via `getChatAdapter(agent.provider)` and pass it down —
   *  pre-resolving (vs. looking up inside the loop) means a missing
   *  adapter is caught at the call site with the agent context
   *  available for the error message, not inside the loop's first
   *  iteration. */
  adapter: ChatDispatcher;
  /** API key for the adapter's provider. Resolved by the caller from
   *  the agent's apiKeyId (the agents table has the same apiKeyId
   *  column the ai_workers table uses). */
  apiKey: string;
  model: string;
  params: AgentParams;
  ownerId: string;
  /** The agent row's id, written onto any pending_tool_calls rows so the
   *  /pending UI can show which agent proposed each call. Optional —
   *  callers without an agent context (manual scripts) can skip it. */
  agentId?: string;
  /** The agent row's slug. Passed to handlers (specifically
   *  `invoke_agent`) so they can refuse self-calls + reason about who
   *  invoked them. Optional for scripts that aren't running an agent. */
  agentSlug?: string;
  /** Depth this agent is running at in a delegation chain. 1 = entry
   *  point. 2 = invoked by another agent. invoke_agent caps at
   *  MAX_AGENT_DEPTH. Defaults to 1. */
  agentDepth?: number;
  /** Agent slugs this agent is permitted to invoke via the
   *  `invoke_agent` builtin. Sourced from `memory_config.delegate_to`.
   *  Empty/missing = no delegation allowed (fail closed). */
  delegateTo?: readonly string[];
  /** Parent trace id, if this loop is running inside another trace
   *  (i.e. it was invoked by another agent). Forwarded to handlers
   *  so the child trace can reference it. */
  parentTraceId?: string | null;
  /** Per-agent tool-result handling override (from
   *  `memory_config.result_handling`, KB units). Controls when an oversized
   *  tool result spills to the store vs. inlines. Falls back to env/global
   *  defaults when absent. */
  resultHandling?: ResultHandlingConfig | null;
  /** Initial messages: system + any history + the new user turn. */
  initialMessages: ChatMessage[];
  /** Tool rows the agent is permitted to use. Empty array → no tools sent. */
  tools: Tool[];
  /** Max LLM round-trips before forcing a final answer. Default 6. */
  maxIterations?: number;
  /** Which surface this loop is running on. Threaded into every
   *  tool handler's `ctx.surface`. Set by the caller — handleMessage
   *  passes `{kind: 'telegram', telegramChatId, ...}`, the web
   *  assistant passes `{kind: 'web'}`. Optional because background
   *  callers (extractor/reflector/manual scripts) don't have a
   *  surface; worker-delegation tools refuse cleanly when this is
   *  absent. */
  surface?:
    | {
        kind: 'telegram';
        telegramChatId: string;
        replyToTelegramMessageId?: string;
      }
    | { kind: 'web' };
};

/**
 * Resolve a set of slugs to enabled tool rows. Convenience for callers
 * that have slugs (from agent.tool_slugs + skill.tool_slugs union) but
 * not the full rows yet.
 */
export async function resolveAgentTools(
  ownerId: string,
  slugs: string[],
): Promise<Tool[]> {
  if (slugs.length === 0) return [];
  return resolveTools(ownerId, slugs);
}

/**
 * Convert resolved tools to the chat-adapter `tools` parameter shape.
 * The slug becomes the function name (no remapping at runtime —
 * keeps the model's tool_use names directly resolvable). Adapters
 * translate this OpenAI-compat shape to their native form (Anthropic's
 * `input_schema`, Google's `functionDeclarations`, etc.).
 */
export function buildToolsForModel(tools: Tool[]): ChatToolDefinition[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.slug,
      description: t.description,
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    },
  }));
}

export async function runToolLoop(args: ToolLoopArgs): Promise<ToolLoopResult> {
  const maxIters = args.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const handling = resolveResultHandling(args.resultHandling);
  // Always offer `read_result` when the agent has any tools, so a spilled
  // (oversized) result is never a dead end — even if the operator didn't add
  // it to the agent's allowlist. It's a read-only system capability.
  let loopTools = args.tools;
  if (loopTools.length > 0 && !loopTools.some((t) => t.slug === 'read_result')) {
    const rr = await resolveReadResultTool(args.ownerId);
    if (rr) loopTools = [...loopTools, rr];
  }
  const toolsByName = new Map(loopTools.map((t) => [t.slug, t]));
  const toolsForModel = buildToolsForModel(loopTools);
  const sendTools = toolsForModel.length > 0;

  const messages: ChatMessage[] = [...args.initialMessages];
  const toolCalls: ToolCallRecord[] = [];
  const pendingIds: string[] = [];
  // Sidecar artifacts (audio bytes, image bytes) collected across
  // every handler invocation in this loop. Surfaced in the
  // ToolLoopResult for callers that want to render them inline
  // (web /assistant). Telegram-path tools deliver via their own
  // send* calls and don't populate this.
  const artifacts: ToolArtifact[] = [];

  for (let iter = 0; iter < maxIters; iter++) {
    const result = await step(
      {
        name:
          iter === 0
            ? `${args.adapter.adapterName}_chat`
            : `${args.adapter.adapterName}_chat[${iter}]`,
        kind: 'llm_call',
        input: {
          model: args.model,
          provider: args.adapter.providerId,
          iter,
          tools: toolsForModel.length,
        },
      },
      async (h) => {
        const r = await args.adapter.chat({
          apiKey: args.apiKey,
          model: args.model,
          messages: messages,
          ...(sendTools ? { tools: toolsForModel } : {}),
          // Prompt-cache breakpoints: mark the system block (persona +
          // skills stay turn-to-turn) and the most recent user message
          // (re-sent context monotonically grows; pre-mark for next-turn
          // cache hit). Adapters whose providers don't support cache
          // markers ignore this — see ChatCacheControl docs.
          cacheControl: { systemPrompt: true, lastUserMessage: true },
          ...(typeof args.params.temperature === 'number' ? { temperature: args.params.temperature } : {}),
          ...(typeof args.params.max_tokens === 'number' ? { maxTokens: args.params.max_tokens } : {}),
          ...(typeof args.params.top_p === 'number' ? { topP: args.params.top_p } : {}),
        });
        recordChatUsage(h, r, args.model);
        return r;
      },
    );

    const calls = result.toolCalls;

    if (!calls || calls.length === 0) {
      // Final text response. Done.
      const text = result.text;
      messages.push({ role: 'assistant', content: text });
      return { reply: text, messages, iterations: iter + 1, toolCalls, pendingIds, artifacts };
    }

    // Push the assistant message verbatim so the next LLM call sees its
    // own prior tool_calls + the upcoming tool results in the right
    // pairing. content may be empty when the model only wanted to call.
    messages.push({
      role: 'assistant',
      content: result.text || null,
      toolCalls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.function.name, arguments: c.function.arguments },
      })),
    });

    // Execute each call, append tool message.
    //
    // In-response duplicate guard. Some models (notably Grok-4.x) hedge by
    // emitting multiple BYTE-IDENTICAL `tool_use` blocks for the same write
    // operation in a single response. Without this guard the loop happily
    // dispatched all of them — 3× page_create with the same body created 3
    // pages. Scope is per-iteration (one model response): an across-turn
    // repeat is legitimate (the model re-reading after some processing), so
    // the Map resets at the top of each iter. Raw-string compare is fine
    // because models emit deterministic JSON within one response.
    const seenSignatures = new Map<string, string>(); // signature → first call.id
    for (const call of calls) {
      const startedAt = Date.now();
      const slug = call.function.name;
      const argsRaw = call.function.arguments ?? '{}';
      const signature = `${slug}::${argsRaw}`;
      const firstCallId = seenSignatures.get(signature);
      if (firstCallId !== undefined) {
        // Suppress. We still MUST push a tool message paired with this
        // call.id — providers (OpenAI, Anthropic) reject the next request
        // shape otherwise — so the synthetic result tells the model what
        // happened and points at the first call's id for reference.
        const dupNote = {
          ok: false as const,
          error: 'duplicate_in_response',
          note:
            `This exact tool call (same name + same arguments) appeared more ` +
            `than once in your response. Only the first was dispatched ` +
            `(call_id ${firstCallId}); this duplicate was suppressed to ` +
            `prevent accidental write amplification. If you intended a ` +
            `single operation, the first call's result stands. If you ` +
            `intended distinct operations, re-issue with different arguments.`,
          first_call_id: firstCallId,
        };
        await step(
          {
            name: `tool: ${slug}`,
            kind: 'compute',
            input: { slug, args: '<duplicate, suppressed>' },
          },
          async (handle) => {
            handle.setSkipped('duplicate_in_response');
            // `model` is denormalised onto the suppression step's meta so
            // the /debug "duplicates suppressed by model" widget can group
            // by it without a lateral join back to the trace's first
            // llm_call step. Cheap to write, cheap to query.
            handle.setMeta({
              duplicate_in_response: true,
              first_call_id: firstCallId,
              call_id: call.id,
              model: args.model,
            });
          },
        );
        toolCalls.push({
          slug,
          argsJson: argsRaw,
          durationMs: 0,
          status: 'error',
          error: 'duplicate_in_response',
        });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(dupNote),
        });
        continue;
      }
      seenSignatures.set(signature, call.id);

      const tool = toolsByName.get(slug);
      // Parse the LLM-supplied arguments string into a JSON object,
      // or capture a structured error for the tool_result. See
      // tool-args.ts for the cases (malformed JSON, non-object, etc.).
      const parsedArgs = parseToolArgs(call.function.arguments);
      const input: Record<string, unknown> = parsedArgs.ok ? parsedArgs.input : {};
      const argParseError: string | null = parsedArgs.ok ? null : parsedArgs.error;

      // Redact sensitive input fields BEFORE they're written to
      // `trace_steps.input`. The `redactedInput` is what we log; the
      // handler still receives the original `input` with the plaintext
      // value. This is the only mitigation for tools like
      // `secret_create` whose whole point is sealing a value — if we
      // logged the raw args, the plaintext PIN would live in Postgres
      // forever next to the sealed copy. Belt and braces.
      const redactedInput = redactArgsForLogging(input, getBuiltinRedactFields(slug));
      const outcome = await step(
        {
          name: `tool: ${slug}`,
          kind: 'compute',
          input: { slug, args: redactedInput },
        },
        async (handle) => {
          if (argParseError) {
            handle.setMeta({ error: argParseError, argsRaw: call.function.arguments });
            return {
              ok: false as const,
              error:
                `${argParseError}. Re-issue the tool call with a valid JSON object ` +
                `whose keys match the tool's inputSchema. Do not retry with the same arguments.`,
            };
          }
          if (!tool) {
            handle.setMeta({ error: 'tool not in agent allowlist' });
            return {
              ok: false as const,
              error: `tool '${slug}' is not in this agent's allowlist`,
            };
          }
          // Confirmation gate: a tool flagged requires_confirm doesn't
          // execute here. Instead we persist a pending_tool_calls row;
          // the operator approves/rejects via /pending. The synthetic
          // tool_result tells the model the action is queued so it can
          // wrap up its turn coherently.
          if (tool.requiresConfirm) {
            const traceId = currentTrace()?.id ?? null;
            // Note: pendingToolCalls.args stores the ORIGINAL input
            // (not the redacted copy) because the approve path needs
            // it to execute the tool later. Sensitive tools that route
            // through requires_confirm therefore expose their args to
            // /pending until they're approved or rejected. That's an
            // acceptable single-user tradeoff; if multi-tenant ever
            // happens, pendingToolCalls.args needs to be sealed too.
            const [pending] = await db
              .insert(pendingToolCalls)
              .values({
                ownerId: args.ownerId,
                agentId: args.agentId ?? null,
                toolSlug: slug,
                args: input,
                traceId,
              })
              .returning({ id: pendingToolCalls.id });
            const pendingId = pending?.id ?? null;
            if (pendingId) pendingIds.push(pendingId);
            handle.setSkipped('requires_confirm');
            handle.setMeta({ pendingId, requiresConfirm: true });
            return {
              ok: true as const,
              output: {
                status: 'queued_for_approval',
                pending_id: pendingId,
                message:
                  `The tool '${slug}' requires operator approval. ` +
                  `A pending entry was queued at /pending. Tell the user what's queued ` +
                  `and that it'll run once approved. Do not call the same tool again ` +
                  `in this turn.`,
              },
            };
          }
          return dispatchTool(tool, input, {
            ownerId: args.ownerId,
            step: {
              setMeta: (m) => handle.setMeta(m),
              setOutput: (o) => handle.setOutput(o),
              // Let a tool that calls an LLM (e.g. web_search → Sonar)
              // attribute its spend to this step → the active trace.
              addTokens: (d) => handle.addTokens(d),
              addCost: (mu) => handle.addCost(mu),
            },
            // Populated only when the caller passed agent context.
            // The `invoke_agent` builtin requires it; regular tools
            // ignore it.
            ...(args.agentSlug
              ? {
                  agent: {
                    slug: args.agentSlug,
                    depth: args.agentDepth ?? 1,
                    delegateTo: args.delegateTo ?? [],
                    parentTraceId: args.parentTraceId ?? null,
                  },
                }
              : {}),
            // Per-turn surface (Telegram chat id, /assistant, …) so
            // worker-delegation tools know where to send results.
            // Absent for background callers (reflector/extractor) —
            // synthesize_speech & friends refuse cleanly when missing.
            ...(args.surface ? { surface: args.surface } : {}),
          });
        },
      );

      const duration = Date.now() - startedAt;
      toolCalls.push({
        slug,
        argsJson: call.function.arguments ?? '{}',
        durationMs: duration,
        status: outcome.ok ? 'success' : 'error',
        error: outcome.ok ? undefined : outcome.error,
      });

      // Harvest any sidecar artifacts the tool emitted (audio bytes,
      // image bytes). These don't go into the LLM-visible result —
      // see ToolHandlerResult comment — they ride the
      // ToolLoopResult.artifacts list and the caller decides what
      // to do with them.
      if (outcome.ok && outcome.artifacts && outcome.artifacts.length > 0) {
        for (const a of outcome.artifacts) artifacts.push(a);
      }

      // Feed the result back to the model. Errors are sent as JSON too —
      // the model usually adapts (retries with different args, falls
      // back to a plain answer) rather than blowing up.
      //
      // Oversized OK results no longer get truncated (which silently dropped
      // content): they spill to the tool-result store and the model receives
      // a handle envelope it can page/grep/query via `read_result`. The small
      // path stays a plain inline assignment with zero overhead.
      let payload: string;
      if (!outcome.ok) {
        payload = JSON.stringify({ error: outcome.error });
      } else {
        const serialized = JSON.stringify(outcome.output);
        if (Buffer.byteLength(serialized, 'utf8') <= handling.inlineMaxBytes) {
          payload = serialized;
        } else {
          payload = await step(
            {
              name: `spill_result: ${slug}`,
              kind: 'compute',
              input: { bytes: Buffer.byteLength(serialized, 'utf8') },
            },
            async (h) => {
              const processed = await processToolResultForModel({
                serialized,
                ownerId: args.ownerId,
                traceId: currentTrace()?.id ?? null,
                toolSlug: slug,
                handling,
              });
              h.setMeta({
                spilled: processed.spilled,
                handle: processed.handle,
                bytes: processed.bytes,
              });
              return processed.payload;
            },
          );
        }
      }
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: payload,
      });
    }
  }

  // Loop exhausted without a final text response. Last message is a
  // tool result; force one more answer-only call so we don't return
  // nothing. This is a safety net — typical conversations finish well
  // under maxIters.
  const finalResult = await step(
    {
      name: `${args.adapter.adapterName}_chat[force_final]`,
      kind: 'llm_call',
      input: {
        model: args.model,
        provider: args.adapter.providerId,
        reason: 'max_iters_reached',
      },
    },
    async (h) => {
      const r = await args.adapter.chat({
        apiKey: args.apiKey,
        model: args.model,
        messages: messages,
        // toolChoice: 'none' explicitly disables tool calling for the
        // final pass — force a text answer. Adapters whose providers
        // don't honour 'none' fall back to dropping the tools field
        // (Anthropic) or no-op (xAI/HF treat it as auto).
        toolChoice: 'none',
        cacheControl: { systemPrompt: true },
      });
      recordChatUsage(h, r, args.model);
      return r;
    },
  );
  const text = finalResult.text;
  messages.push({ role: 'assistant', content: text });
  return { reply: text, messages, iterations: maxIters + 1, toolCalls, pendingIds, artifacts };
}
