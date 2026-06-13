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
  notifyPendingCreated,
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
import { isChatFailover } from './chat-failover';
import type { ChatMessage } from './messages';
import { parseToolArgs } from './tool-args';

const DEFAULT_MAX_ITERATIONS = 6;

// ── Tool-volume guards (structural backstop against tool-spam runaways) ──
// A misbehaving model (notably Grok-4.x fixating on one tool) can emit hundreds
// of tool calls, ballooning context + cost — one prod turn fired page_unshare
// 1599× and burned $0.73 before crashing. max_iters caps ROUNDS, not
// calls-per-round, and the in-response dedup only catches byte-identical
// repeats, so volume needs its own caps. Flat globals for now; per-agent
// overrides can come later.
const MAX_TOOL_CALLS_PER_RESPONSE = 20; // calls beyond this in ONE response are dropped
const MAX_TOOL_CALLS_PER_TURN = 40; // cumulative across rounds → then force a final answer
const MAX_CALLS_PER_TOOL_PER_TURN = 15; // same-tool fixation breaker (counts even when args vary)

/** Process-lifetime cache of the resolved `read_result` tool row, keyed by
 *  owner. It's a stable seeded builtin, so resolving it once per owner avoids
 *  a per-turn DB query on the always-offer path. Misses aren't cached (so it
 *  picks up once seeding has run). */
const readResultToolByOwner = new Map<string, Tool>();

async function resolveReadResultTool(ownerId: string): Promise<Tool | null> {
  const cached = readResultToolByOwner.get(ownerId);
  if (cached) return cached;
  const row = await resolveTool(ownerId, 'read_result');
  if (!row) return null;
  // read_result is auto-offered so a spilled (oversized) result is never a dead
  // end. If it were ever flagged requires_confirm, the spill-recovery call would
  // block behind /pending and strand the model mid-turn — force it off for the
  // always-offer path (it's a read-only system capability, safe to auto-run).
  if (row.requiresConfirm) {
    console.warn(
      '[tool-loop] read_result is flagged requires_confirm; overriding to false for the auto-offer path',
    );
  }
  const safe: Tool = row.requiresConfirm ? { ...row, requiresConfirm: false } : row;
  readResultToolByOwner.set(ownerId, safe);
  return safe;
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
  /** Per-route host + tailnet flag for the PRIMARY (migration 0063). The
   *  `local` chat adapter honours them; others ignore them. */
  baseUrl?: string | null;
  viaTailnet?: boolean;
  /** Optional BACKUP chat route (a different provider/model is fine for chat).
   *  Resolved by the caller via `resolveRouteAdapter(ownerId, routes.backup)`.
   *  When set and the primary hits a route-DOWN / 429 / 5xx error mid-loop, the
   *  loop fails over to this route and stays on it for the REST of the turn
   *  (sticky — no flip-flopping models mid-reasoning). The next turn starts on
   *  the primary again. Carries its OWN baseUrl/viaTailnet (a cloud-direct
   *  backup must not inherit a local-via-tailnet primary's routing). */
  backup?: {
    adapter: ChatDispatcher;
    apiKey: string;
    model: string;
    baseUrl?: string | null;
    viaTailnet?: boolean;
  };
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
 * that have slugs (from the agent's granted tool groups; P6) but not the
 * full rows yet.
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

  // The active route. Starts on the primary; a mid-loop route-DOWN / 429 / 5xx
  // failure flips it to the backup for the REST of this turn (sticky), so we
  // don't switch models halfway through a reasoning chain. A fresh turn calls
  // runToolLoop again and starts on the primary.
  let active = {
    adapter: args.adapter,
    apiKey: args.apiKey,
    model: args.model,
    baseUrl: args.baseUrl ?? null,
    viaTailnet: args.viaTailnet ?? false,
  };
  let failedOver = false;

  // Tool-volume guards (see constants above). Turn-scoped: the budget is
  // cumulative across rounds; per-tool counts catch single-tool fixation even
  // when the model varies the args to slip past the in-response dedup.
  let totalToolCalls = 0;
  const perToolCounts = new Map<string, number>();
  let budgetExhausted = false;

  // Skip a tool call WITHOUT executing it, still emitting the synthetic
  // tool_result the provider protocol requires (every tool_call needs a paired
  // result) plus a trace step. Used by the volume guards below.
  const skipToolCall = async (
    call: { id: string; function: { name: string; arguments: string } },
    reason: string,
    note: string,
  ): Promise<void> => {
    const slug = call.function.name;
    const argsRaw = call.function.arguments ?? '{}';
    await step(
      { name: `tool: ${slug}`, kind: 'compute', input: { slug, args: '<capped, suppressed>' } },
      async (handle) => {
        handle.setSkipped(reason);
        handle.setMeta({ [reason]: true, call_id: call.id, model: args.model });
      },
    );
    toolCalls.push({ slug, argsJson: argsRaw, durationMs: 0, status: 'error', error: reason });
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: JSON.stringify({ ok: false, error: reason, note }),
    });
  };

  // Empty-reply backstop. Some models return literally zero output tokens on
  // a text-only call whose transcript ends in tool results — observed on
  // gemini-3.5-flash in the force-final pass (2026-06-11 web turn that 500'd
  // with 'assistant: empty reply from model'). One retry with an explicit
  // user-role nudge gives the model something concrete to respond to; runs on
  // the ACTIVE route. Still-empty after the retry is returned as-is — the
  // caller decides how to degrade (the web assistant substitutes a fallback
  // reply instead of failing the turn).
  const retryEmptyReply = async (reason: string): Promise<string> => {
    messages.push({
      role: 'user',
      content:
        '(Your previous response was empty. Reply now with your final answer to ' +
        'the user, in plain text. Do not call tools.)',
    });
    return step(
      {
        name: `${active.adapter.adapterName}_chat[empty_retry]`,
        kind: 'llm_call',
        input: { model: active.model, provider: active.adapter.providerId, reason },
      },
      async (h) => {
        const r = await active.adapter.chat({
          apiKey: active.apiKey,
          model: active.model,
          ...(active.baseUrl ? { baseUrl: active.baseUrl } : {}),
          ...(active.viaTailnet ? { viaTailnet: true } : {}),
          messages,
          toolChoice: 'none',
          cacheControl: { systemPrompt: true },
          ...(typeof args.params.max_retries === 'number' ? { maxRetries: args.params.max_retries } : {}),
        });
        recordChatUsage(h, r, active.model);
        if (!r.text.trim()) h.setMeta({ still_empty: true });
        return r.text;
      },
    );
  };

  for (let iter = 0; iter < maxIters; iter++) {
    const result = await step(
      {
        name:
          iter === 0
            ? `${active.adapter.adapterName}_chat`
            : `${active.adapter.adapterName}_chat[${iter}]`,
        kind: 'llm_call',
        input: {
          model: active.model,
          provider: active.adapter.providerId,
          iter,
          tools: toolsForModel.length,
          ...(failedOver ? { failed_over: true } : {}),
        },
      },
      async (h) => {
        const chatOpts = {
          messages,
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
          ...(typeof args.params.max_retries === 'number' ? { maxRetries: args.params.max_retries } : {}),
        };
        try {
          const r = await active.adapter.chat({
            apiKey: active.apiKey,
            model: active.model,
            ...(active.baseUrl ? { baseUrl: active.baseUrl } : {}),
            ...(active.viaTailnet ? { viaTailnet: true } : {}),
            ...chatOpts,
          });
          recordChatUsage(h, r, active.model);
          return r;
        } catch (err) {
          // Fail over to the backup once per turn, only on a route-DOWN /
          // 429 / 5xx error. 4xx bad-input would fail identically on the
          // backup, so rethrow those.
          if (!args.backup || failedOver || !isChatFailover(err)) throw err;
          console.warn(
            `[tool-loop] primary '${active.adapter.adapterName}:${active.model}' failed ` +
              `(${err instanceof Error ? err.message : String(err)}) — failing over to backup ` +
              `'${args.backup.adapter.adapterName}:${args.backup.model}' for the rest of this turn`,
          );
          active = {
            adapter: args.backup.adapter,
            apiKey: args.backup.apiKey,
            model: args.backup.model,
            baseUrl: args.backup.baseUrl ?? null,
            viaTailnet: args.backup.viaTailnet ?? false,
          };
          failedOver = true;
          const r = await active.adapter.chat({
            apiKey: active.apiKey,
            model: active.model,
            ...(active.baseUrl ? { baseUrl: active.baseUrl } : {}),
            ...(active.viaTailnet ? { viaTailnet: true } : {}),
            ...chatOpts,
          });
          recordChatUsage(h, r, active.model);
          return r;
        }
      },
    );

    const calls = result.toolCalls;

    if (!calls || calls.length === 0) {
      // Final text response. Done.
      let text = result.text;
      if (!text.trim()) text = await retryEmptyReply('final_round_empty');
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
    let responseCallIndex = 0; // non-duplicate calls dispatched THIS response (per-response cap)
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

      // ── Volume guards (structural backstop against tool-spam runaways) ──
      // Each emits a paired synthetic result so the provider protocol stays
      // valid, then skips execution — bounding cost regardless of how wild the
      // model gets. These count only non-duplicate calls (dupes already handled).
      responseCallIndex += 1;
      if (responseCallIndex > MAX_TOOL_CALLS_PER_RESPONSE) {
        await skipToolCall(
          call,
          'too_many_calls_in_response',
          `You issued more than ${MAX_TOOL_CALLS_PER_RESPONSE} tool calls in one ` +
            `response; the rest were not run. Issue fewer, more deliberate calls.`,
        );
        continue;
      }
      if (totalToolCalls >= MAX_TOOL_CALLS_PER_TURN) {
        await skipToolCall(
          call,
          'turn_tool_budget_reached',
          `This turn reached its tool-call budget (${MAX_TOOL_CALLS_PER_TURN}). ` +
            `Stop calling tools and answer with what you already have.`,
        );
        budgetExhausted = true;
        continue;
      }
      const priorForTool = perToolCounts.get(slug) ?? 0;
      if (priorForTool >= MAX_CALLS_PER_TOOL_PER_TURN) {
        await skipToolCall(
          call,
          'tool_repeat_limit',
          `You've called '${slug}' ${priorForTool} times this turn (limit ` +
            `${MAX_CALLS_PER_TOOL_PER_TURN}); further '${slug}' calls are blocked. ` +
            `Stop repeating it — answer, or take a different approach.`,
        );
        continue;
      }
      perToolCounts.set(slug, priorForTool + 1);
      totalToolCalls += 1;

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
            handle.setMeta({ argsRaw: call.function.arguments });
            handle.setError(argParseError);
            return {
              ok: false as const,
              error:
                `${argParseError}. Re-issue the tool call with a valid JSON object ` +
                `whose keys match the tool's inputSchema. Do not retry with the same arguments.`,
            };
          }
          if (!tool) {
            handle.setError(`tool '${slug}' is not in this agent's allowlist`);
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
            if (pendingId) {
              pendingIds.push(pendingId);
              // Surface the approval wherever the operator is: live badge
              // + a one-tap Telegram card. Fire-and-forget — the row is
              // already persisted and /pending owns the truth.
              void notifyPendingCreated({
                ownerId: args.ownerId,
                pendingId,
                toolSlug: slug,
                args: input,
                via: args.agentSlug ? `agent ${args.agentSlug}` : undefined,
              });
            }
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
          const result = await dispatchTool(tool, input, {
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
          // Surface a tool's structured failure onto the step so /traces shows
          // it as an error, not a 'success' with empty output. (A mis-calling
          // model — e.g. Grok page_share with a bogus id — otherwise looks like
          // it succeeded N times.)
          if (!result.ok) handle.setError(result.error);
          return result;
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
        // Tell cache-aware adapters this result is an error (the runtime
        // knows via outcome.ok) so they set the provider's is_error flag.
        ...(outcome.ok ? {} : { isError: true as const }),
      });
    }
    // Per-turn tool budget hit mid-round → stop looping and force a final
    // answer with what we have (the force-final pass below).
    if (budgetExhausted) break;
  }

  // Loop exhausted without a final text response. Last message is a
  // tool result; force one more answer-only call so we don't return
  // nothing. This is a safety net — typical conversations finish well
  // under maxIters.
  // Runs on the ACTIVE route (not args.*): if the turn failed over mid-loop,
  // going back to the primary here would re-hit the route that just died —
  // and the active route's baseUrl/viaTailnet must travel too (a local
  // adapter without its baseUrl is a dead call).
  const finalResult = await step(
    {
      name: `${active.adapter.adapterName}_chat[force_final]`,
      kind: 'llm_call',
      input: {
        model: active.model,
        provider: active.adapter.providerId,
        reason: 'max_iters_reached',
        ...(failedOver ? { failed_over: true } : {}),
      },
    },
    async (h) => {
      const r = await active.adapter.chat({
        apiKey: active.apiKey,
        model: active.model,
        ...(active.baseUrl ? { baseUrl: active.baseUrl } : {}),
        ...(active.viaTailnet ? { viaTailnet: true } : {}),
        messages: messages,
        // toolChoice: 'none' explicitly disables tool calling for the
        // final pass — force a text answer. Adapters whose providers
        // don't honour 'none' fall back to dropping the tools field
        // (Anthropic) or no-op (xAI/HF treat it as auto).
        toolChoice: 'none',
        cacheControl: { systemPrompt: true },
        ...(typeof args.params.max_retries === 'number' ? { maxRetries: args.params.max_retries } : {}),
      });
      recordChatUsage(h, r, active.model);
      return r;
    },
  );
  let text = finalResult.text;
  if (!text.trim()) text = await retryEmptyReply('force_final_empty');
  messages.push({ role: 'assistant', content: text });
  return { reply: text, messages, iterations: maxIters + 1, toolCalls, pendingIds, artifacts };
}
