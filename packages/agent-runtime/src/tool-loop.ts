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

import { createHash } from 'node:crypto';
import {
  currentTrace,
  step,
  isTurnStreaming,
  emitTurnDelta,
  currentTurnAbortSignal,
} from '@mantle/tracing';
import {
  dispatchTool,
  getBuiltinRedactFields,
  redactArgsForLogging,
  resolveTool,
  resolveTools,
  processToolResultForModel,
  resolveResultHandling,
  notifyPendingCreated,
  validateToolArgs,
  sanitizeToolError,
  getDynamicSchema,
  UNTRUSTED_CONTENT_TOOL_SLUGS,
  type ValidateArgsResult,
  type ResultHandlingConfig,
  type ToolCallRecord,
} from '@mantle/tools';
import { and, eq, sql } from 'drizzle-orm';
import { db, pendingToolCalls, type Tool, type AgentParams } from '@mantle/db';
import type { ToolArtifact } from '@mantle/tools';
import {
  getChatAdapter,
  type ChatDispatcher,
  type ChatOptions,
  type ChatResult,
  type ChatToolDefinition,
} from '@mantle/voice';
import { recordChatUsage } from './llm-usage';
import { isChatFailover } from './chat-failover';
import type { ChatMessage } from './messages';
import { fenceRetrieved } from './messages';
import { parseToolArgs } from './tool-args';

const DEFAULT_MAX_ITERATIONS = 6;

/** Min thinking budget the reasoning providers accept (Anthropic's
 *  `thinking.budget_tokens` floor; OpenRouter forwards ours there). Below this a
 *  positive budget would itself 400, so we drop thinking instead. */
const MIN_THINKING_BUDGET = 1024;

/**
 * Clamp a requested thinking budget against the agent's `max_tokens`.
 *
 * The reasoning providers (OpenRouter→Anthropic, Gemini) require the thinking
 * budget to be strictly less than `max_tokens` and leave room for the answer; a
 * budget ≥ max_tokens 400s the request. We cap at half the token budget so
 * thinking never starves the reply, then floor-or-drop at the provider minimum.
 * `max_tokens` unset ⇒ the provider uses its own (large) default, so the budget
 * passes through untouched. A 0/negative request stays 0 (off).
 */
export function clampThinkingBudget(requested: number, maxTokens: number | undefined): number {
  if (requested <= 0) return 0;
  if (typeof maxTokens !== 'number' || maxTokens <= 0) return requested;
  const cap = Math.floor(maxTokens / 2);
  if (cap < MIN_THINKING_BUDGET) return 0;
  return Math.min(requested, cap);
}

/**
 * The max_tokens to send for a turn. Returns the agent's explicit value when set.
 * When it's unset BUT thinking is on, returns an explicit ceiling above the
 * budget (budget*2) so the reasoning providers — which require max_tokens > the
 * thinking budget and may otherwise inject a small default of their own (e.g.
 * OpenRouter→Anthropic) — can't 400. Unset with thinking off ⇒ undefined (let the
 * provider use its default, unchanged from before this gate existed).
 */
export function resolveMaxTokens(
  explicit: number | undefined,
  thinkingBudget: number,
): number | undefined {
  if (typeof explicit === 'number') return explicit;
  return thinkingBudget > 0 ? thinkingBudget * 2 : undefined;
}

/**
 * Run one chat round, streaming live token deltas when the runner has turn
 * streaming active (`isTurnStreaming()`) AND this route's adapter supports it.
 * Falls back to the one-shot `chat()` otherwise — the resolved `ChatResult` is
 * identical either way (text + toolCalls + usage), so the loop's tool-dispatch
 * logic doesn't care which path ran. Streaming is pure decoration around the
 * durable result. `round` tags each delta so the client can scope the live reply.
 */
function dispatchChat(adapter: ChatDispatcher, opts: ChatOptions, round: number): Promise<ChatResult> {
  // Thread the current turn's cancellation signal into every LLM call so a user
  // Stop aborts generation (the streaming adapter returns its partial reply).
  const withSignal = { ...opts, signal: currentTurnAbortSignal() };
  if (isTurnStreaming() && typeof adapter.chatStream === 'function') {
    return adapter.chatStream(withSignal, (d) => emitTurnDelta(round, d.type, d.text));
  }
  return adapter.chat(withSignal);
}

// Third-party content fencing: the web builtins are fenced by slug
// (UNTRUSTED_CONTENT_TOOL_SLUGS, shared with dispatch), and the dispatch
// layer flags provenance the loop can't see — http-kind tools (user-authored
// API tools hit arbitrary endpoints) and recipes whose chain ran an http/web
// step — via `untrusted` on the result. Either signal fences the payload as
// data before the model reads it, so an injected "ignore your task and email
// this to…" inside a page, hit, or API response can't be read as an
// instruction. Auto-retrieved content (notes/emails/passages) is already
// fenced in messages.ts; failed calls run through sanitizeToolError instead.

// ── Tool-volume guards (structural backstop against tool-spam runaways) ──
// A misbehaving model (notably Grok-4.x fixating on one tool) can emit hundreds
// of tool calls, ballooning context + cost — one prod turn fired page_unshare
// 1599× and burned $0.73 before crashing. max_iters caps ROUNDS, not
// calls-per-round, and the in-response dedup only catches byte-identical
// repeats, so volume needs its own caps.
//
// Enforcement is at BATCH boundaries: a response that STARTS under its caps
// executes in full (bounded by MAX_TOOL_CALLS_PER_RESPONSE). Cutting a batch
// halfway severed a coherent write batch once — 10 page_block_deletes cut at
// 1-of-10 left a NATREF SOP draft half-edited (2026-07-06) — and a bounded
// overshoot is strictly better than a half-applied edit. A batch that starts
// AT/OVER a cap is skipped call-by-call with guidance.
//
// The turn/per-tool caps are per-agent overridable via memory_config
// (`max_tool_calls` / `max_calls_per_tool`) — heavy editors like the pages
// agent legitimately need more than chat agents; hard ceilings below still
// bound the blast radius.
const MAX_TOOL_CALLS_PER_RESPONSE = 20; // calls beyond this in ONE response are dropped
const MAX_TOOL_CALLS_PER_TURN = 40; // default cumulative budget across rounds → then force a final answer
const MAX_CALLS_PER_TOOL_PER_TURN = 15; // default same-tool fixation breaker (counts even when args vary)
const HARD_MAX_TOOL_CALLS_PER_TURN = 200; // ceiling for per-agent overrides
const HARD_MAX_CALLS_PER_TOOL_PER_TURN = 100; // ceiling for per-agent overrides

// ── Failure-aware guards (outcome-sensitive complements to the caps above) ──
// The volume caps count calls regardless of what they produced, so a flail
// loop — the model re-issuing one broken call verbatim, or re-reading state
// that never changes — burns up to 15 calls before the fixation cap ends it.
// These two watch OUTCOMES per exact signature (slug + raw args) and step in
// far earlier. The error payload starts teaching at the 2nd identical
// failure; at the limit the call is skipped, not dispatched.
const REPEATED_FAILURE_LIMIT = 5; // identical call failed N times → further attempts blocked
const NO_PROGRESS_LIMIT = 5; // identical call returned the identical result N times → blocked

// ── Central arg validation (coerce-then-validate) ──
// Every tool call's args are checked against the tool's own inputSchema
// BEFORE dispatch (see @mantle/tools validate-args.ts). Safe repairs
// (string→number, scalar→array-wrap, …) are applied in 'warn' and 'enforce';
// schema violations block dispatch with a teaching error only in 'enforce'.
// 'warn' is the default so a fleet-wide rollout starts as pure telemetry —
// trace_steps.meta.arg_validation shows exactly what WOULD be rejected —
// and 'enforce' is flipped per box once the violation rate is understood.
export type ToolValidationMode = 'off' | 'warn' | 'enforce';

export function resolveToolValidationMode(env: string | undefined = process.env.MANTLE_TOOL_VALIDATION): ToolValidationMode {
  const raw = (env ?? '').trim().toLowerCase();
  return raw === 'off' || raw === 'enforce' ? raw : 'warn';
}

/** Resolve a per-agent cap override: positive ints only, floored, clamped to
 *  the hard ceiling; anything else falls back to the flat default. */
function resolveCap(requested: number | undefined, fallback: number, ceiling: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 1) return fallback;
  return Math.min(ceiling, Math.floor(requested));
}

/** Cheap stable digest of a serialized tool result, for the no-progress
 *  guard's identical-result comparison. Keeping full payloads per signature
 *  would hold every large read in memory for the whole turn. */
function hashToolResult(serialized: string): string {
  return createHash('sha256').update(serialized).digest('base64').slice(0, 16);
}

// ── Deterministic tool-outcome summary ──
// Computed from the turn's ToolCallRecord list — the runtime's own ledger,
// not the model's memory of it. Injected into the force-final context so a
// budget-ended turn can't misreport what completed, and persisted onto the
// outbound message (run-turn) so the user sees the same numbers.

/** Guard/skip markers recorded as ToolCallRecord.error by skipToolCall and
 *  the in-response dedup — calls that never dispatched, as opposed to calls
 *  whose handler failed. */
const SKIP_REASONS = new Set([
  'duplicate_in_response',
  'too_many_calls_in_response',
  'turn_tool_budget_reached',
  'tool_repeat_limit',
  'repeated_failure',
  'no_progress',
]);

export type ToolOutcomeStats = {
  calls: number;
  succeeded: number;
  failed: number;
  /** Blocked by a guard (dedup/caps/failure-aware) — never dispatched. */
  skipped: number;
  /** Up to 5 distinct handler failures, slug + truncated error. */
  failures: Array<{ slug: string; error: string }>;
};

export function summarizeToolOutcomes(records: readonly ToolCallRecord[]): ToolOutcomeStats {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const failures: Array<{ slug: string; error: string }> = [];
  for (const r of records) {
    if (r.status === 'success') {
      succeeded++;
    } else if (r.error !== undefined && SKIP_REASONS.has(r.error)) {
      skipped++;
    } else {
      failed++;
      if (failures.length < 5) {
        const err = (r.error ?? 'unknown error').slice(0, 120);
        failures.push({ slug: r.slug, error: err });
      }
    }
  }
  return { calls: records.length, succeeded, failed, skipped, failures };
}

/** One-line rendering of the stats for the model-facing nudges. */
function formatOutcomeSummary(stats: ToolOutcomeStats): string {
  const parts = [`${stats.succeeded} succeeded`];
  if (stats.failed > 0) parts.push(`${stats.failed} FAILED`);
  if (stats.skipped > 0) parts.push(`${stats.skipped} blocked by guards (never ran)`);
  let line = `Tool-call record for this turn (runtime ledger, not memory): ${stats.calls} issued — ${parts.join(', ')}.`;
  if (stats.failures.length > 0) {
    line +=
      ` Failed: ` +
      stats.failures.map((f) => `${f.slug} (${f.error})`).join('; ') +
      `.`;
  }
  return line;
}

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
  /** Total output tokens generated across every LLM round of this turn (the
   *  model's own usage, summed; 0 when no provider reported usage). The web
   *  /assistant surfaces it in the turn's `done` event so the live status
   *  footer can show the real count once the turn lands. */
  tokensOut: number;
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
  /** Per-turn adaptive-thinking budget in tokens, pre-resolved by the caller
   *  from the owner's profile prefs (`resolveThinkingBudget` — already gated by
   *  the live-thinking switch AND a positive budget). > 0 requests thinking on
   *  this loop's chat rounds; 0 / unset leaves it off. Clamped per-round against
   *  this agent's `max_tokens` (see `clampThinkingBudget`). Replaced the old
   *  per-box `MANTLE_THINKING_BUDGET` env gate. Delegated specialists inherit
   *  this via the invoke_agent tool-context bridge and re-clamp against their
   *  own max_tokens — see invoke-agent.ts. */
  thinkingBudget?: number;
  /** Initial messages: system + any history + the new user turn. */
  initialMessages: ChatMessage[];
  /** Tool rows the agent is permitted to use. Empty array → no tools sent. */
  tools: Tool[];
  /** Max LLM round-trips before forcing a final answer. Default 6. */
  maxIterations?: number;
  /** Per-agent override for the cumulative tool-call budget per turn
   *  (memory_config.max_tool_calls). Default MAX_TOOL_CALLS_PER_TURN,
   *  hard-capped at HARD_MAX_TOOL_CALLS_PER_TURN. */
  maxToolCallsPerTurn?: number;
  /** Per-agent override for the same-tool fixation cap per turn
   *  (memory_config.max_calls_per_tool). Default MAX_CALLS_PER_TOOL_PER_TURN,
   *  hard-capped at HARD_MAX_CALLS_PER_TOOL_PER_TURN. */
  maxCallsPerToolPerTurn?: number;
  /** Which surface this loop is running on. Threaded into every
   *  tool handler's `ctx.surface`. Set by the caller — handleMessage
   *  passes `{kind: 'telegram', telegramChatId, ...}`, the web
   *  assistant passes `{kind: 'web'}`, the team-chat runner passes
   *  `{kind: 'team', contactId, ...}`. Optional because background
   *  callers (extractor/reflector/manual scripts) don't have a
   *  surface; worker-delegation tools refuse cleanly when this is
   *  absent. The canonical union lives on ToolHandlerContext
   *  (@mantle/tools) — this mirrors it so the two can't drift. */
  surface?: NonNullable<import('@mantle/tools').ToolHandlerContext['surface']>;
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
 *
 * Tools with a registered dynamic-schema hook (@mantle/tools
 * dynamic-schema.ts) get their schema/description rebuilt against current
 * reality here — e.g. `invoke_agent` constrains `agent_slug` to an `enum`
 * of the parent's actual delegation allowlist, making hallucinated slugs
 * unrepresentable up front (the runtime guard stays as defence-in-depth
 * for adapters that ignore `enum`). Hooks run once per turn — schemas are
 * frozen inside a turn, which prompt caching relies on — and a hook
 * failure falls back to the static schema rather than breaking the turn.
 */
export async function buildToolsForModel(
  tools: Tool[],
  ctx: { ownerId: string; delegateTo?: readonly string[] },
): Promise<ChatToolDefinition[]> {
  return Promise.all(
    tools.map(async (t) => {
      let parameters =
        (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} };
      let description = t.description;
      const hook = getDynamicSchema(t.slug);
      if (hook) {
        try {
          const patch = await hook(
            { description, parameters },
            { ownerId: ctx.ownerId, ...(ctx.delegateTo ? { delegateTo: ctx.delegateTo } : {}) },
          );
          if (patch?.parameters) parameters = patch.parameters;
          if (patch?.description) description = patch.description;
        } catch (err) {
          console.warn(
            `[tool-loop] dynamic-schema hook for '${t.slug}' failed; using static schema:`,
            err,
          );
        }
      }
      return {
        type: 'function' as const,
        function: { name: t.slug, description, parameters },
      };
    }),
  );
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
  const toolsForModel = await buildToolsForModel(loopTools, {
    ownerId: args.ownerId,
    ...(args.delegateTo ? { delegateTo: args.delegateTo } : {}),
  });
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

  // Running output-token total for the whole turn (summed across every LLM
  // round, including failover / empty-reply / force-final passes). Returned in
  // the ToolLoopResult so the turn's `done` event can carry the real token count
  // the live status footer reconciles its streamed estimate to.
  let tokensOut = 0;

  // Tool-volume guards (see constants above). Turn-scoped: the budget is
  // cumulative across rounds; per-tool counts catch single-tool fixation even
  // when the model varies the args to slip past the in-response dedup.
  const maxToolCallsPerTurn = resolveCap(
    args.maxToolCallsPerTurn,
    MAX_TOOL_CALLS_PER_TURN,
    HARD_MAX_TOOL_CALLS_PER_TURN,
  );
  const maxCallsPerToolPerTurn = resolveCap(
    args.maxCallsPerToolPerTurn,
    MAX_CALLS_PER_TOOL_PER_TURN,
    HARD_MAX_CALLS_PER_TOOL_PER_TURN,
  );
  // Resolved once per turn: schemas (and therefore what counts as a
  // violation) are frozen for the turn, so the mode should be too.
  const argValidationMode = resolveToolValidationMode();
  let totalToolCalls = 0;
  const perToolCounts = new Map<string, number>();
  // Failure-aware guard state, keyed by exact signature (slug + raw args).
  const exactFailureCounts = new Map<string, number>();
  const identicalResults = new Map<string, { hash: string; count: number }>();
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
        tokensOut += r.tokensOut ?? 0;
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
        // Adaptive thinking on the tool-loop turn (gated per user — resolved by
        // the caller from profile prefs: switch ON + positive budget). When on,
        // the model reasons before answering and the reasoning streams back as
        // `reasoning` deltas + signed `reasoning_details` (echoed across rounds
        // above). Reasoning-capable models reject sampling params, so we drop
        // temperature/top_p whenever thinking is requested.
        //
        // Clamp the budget against the agent's max_tokens: the reasoning
        // providers (OpenRouter→Anthropic, Gemini) require the thinking budget to
        // be < max_tokens AND need room left for the answer, else they 400. Cap
        // at half the token budget; if that floor is below the 1024 provider
        // minimum, drop thinking rather than send a doomed request. When
        // max_tokens is unset the provider uses its own large default, so the
        // budget passes through. (Anthropic-direct ignores the magnitude — it
        // treats any >0 as adaptive on/off — so the clamp is a no-op there.)
        const thinkingBudget = clampThinkingBudget(
          args.thinkingBudget ?? 0,
          args.params.max_tokens,
        );
        // Effective max_tokens for the request. When thinking is on but the agent
        // pinned NO max_tokens, send an explicit ceiling above the budget — the
        // reasoning providers require max_tokens > budget and may inject a small
        // default of their own (e.g. OpenRouter→Anthropic), which would 400. A
        // ceiling of budget*2 keeps the same half-budget headroom the clamp uses.
        const effectiveMaxTokens = resolveMaxTokens(args.params.max_tokens, thinkingBudget);
        const chatOpts = {
          messages,
          ...(sendTools ? { tools: toolsForModel } : {}),
          // Prompt-cache breakpoints: mark the system block (persona +
          // skills stay turn-to-turn) and the most recent user message
          // (re-sent context monotonically grows; pre-mark for next-turn
          // cache hit). Adapters whose providers don't support cache
          // markers ignore this — see ChatCacheControl docs.
          cacheControl: { systemPrompt: true, lastUserMessage: true },
          ...(thinkingBudget > 0 ? { thinkingBudget } : {}),
          ...(thinkingBudget === 0 && typeof args.params.temperature === 'number'
            ? { temperature: args.params.temperature }
            : {}),
          ...(typeof effectiveMaxTokens === 'number' ? { maxTokens: effectiveMaxTokens } : {}),
          ...(thinkingBudget === 0 && typeof args.params.top_p === 'number'
            ? { topP: args.params.top_p }
            : {}),
          ...(typeof args.params.max_retries === 'number' ? { maxRetries: args.params.max_retries } : {}),
        };
        try {
          const r = await dispatchChat(active.adapter, {
            apiKey: active.apiKey,
            model: active.model,
            ...(active.baseUrl ? { baseUrl: active.baseUrl } : {}),
            ...(active.viaTailnet ? { viaTailnet: true } : {}),
            ...chatOpts,
          }, iter);
          recordChatUsage(h, r, active.model);
          tokensOut += r.tokensOut ?? 0;
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
          const r = await dispatchChat(active.adapter, {
            apiKey: active.apiKey,
            model: active.model,
            ...(active.baseUrl ? { baseUrl: active.baseUrl } : {}),
            ...(active.viaTailnet ? { viaTailnet: true } : {}),
            ...chatOpts,
          }, iter);
          recordChatUsage(h, r, active.model);
          tokensOut += r.tokensOut ?? 0;
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
      return { reply: text, messages, iterations: iter + 1, toolCalls, pendingIds, artifacts, tokensOut };
    }

    // Push the assistant message verbatim so the next LLM call sees its
    // own prior tool_calls + the upcoming tool results in the right
    // pairing. content may be empty when the model only wanted to call.
    // Carry any signed reasoning blocks so the adapter can echo them back —
    // a thinking-then-tool_use turn is rejected upstream without them.
    messages.push({
      role: 'assistant',
      content: result.text || null,
      toolCalls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.function.name, arguments: c.function.arguments },
      })),
      ...(result.reasoningDetails && result.reasoningDetails.length > 0
        ? { reasoningDetails: result.reasoningDetails }
        : {}),
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
    // Snapshot the per-tool counters at BATCH start: cap decisions inside this
    // response compare against the snapshot, so a batch that begins under a
    // cap executes in full instead of being severed halfway (see the guard
    // constants' comment — a half-applied write batch is worse than a bounded
    // overshoot; MAX_TOOL_CALLS_PER_RESPONSE bounds the overshoot).
    const perToolCountsAtBatchStart = new Map(perToolCounts);
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
      if (budgetExhausted) {
        // Only reachable when the budget tripped BETWEEN batches (defensive —
        // the post-batch break below normally ends the loop first).
        await skipToolCall(
          call,
          'turn_tool_budget_reached',
          `This turn reached its tool-call budget (${maxToolCallsPerTurn}). ` +
            `Stop calling tools and answer with what you already have.`,
        );
        continue;
      }
      const priorAtBatchStart = perToolCountsAtBatchStart.get(slug) ?? 0;
      if (priorAtBatchStart >= maxCallsPerToolPerTurn) {
        await skipToolCall(
          call,
          'tool_repeat_limit',
          `You've called '${slug}' ${perToolCounts.get(slug) ?? priorAtBatchStart} times this turn ` +
            `(limit ${maxCallsPerToolPerTurn}); further '${slug}' calls are blocked. ` +
            `Stop repeating it — answer, or take a different approach.`,
        );
        continue;
      }
      // ── Failure-aware guards (outcome-sensitive, cross-round) ──
      // The volume caps above count CALLS; these two count what the calls
      // produced. In-response dedup means a signature appears at most once
      // per round, so these only trip on genuine cross-round flail loops —
      // no batch-severing concern. (Pattern from hermes-agent's
      // tool_guardrails: a call that keeps failing identically, or keeps
      // returning the identical result, deserves intervention long before
      // the 15-call fixation cap.)
      const priorExactFailures = exactFailureCounts.get(signature) ?? 0;
      if (priorExactFailures >= REPEATED_FAILURE_LIMIT) {
        await skipToolCall(
          call,
          'repeated_failure',
          `This exact call ('${slug}' with these same arguments) has already failed ` +
            `${priorExactFailures} times this turn; it was blocked, not re-run — repeating it ` +
            `verbatim cannot succeed. Change the arguments or the approach, or answer with ` +
            `what you have.`,
        );
        continue;
      }
      const priorIdentical = identicalResults.get(signature);
      if (priorIdentical && priorIdentical.count >= NO_PROGRESS_LIMIT) {
        await skipToolCall(
          call,
          'no_progress',
          `You've made this exact call ('${slug}' with these same arguments) ` +
            `${priorIdentical.count} times and received the identical result every time — the ` +
            `state isn't changing, so it was blocked, not re-run. Use the result already in ` +
            `context above; if you need different data, change the arguments.`,
        );
        continue;
      }
      perToolCounts.set(slug, (perToolCounts.get(slug) ?? 0) + 1);
      totalToolCalls += 1;

      const tool = toolsByName.get(slug);
      // Parse the LLM-supplied arguments string into a JSON object,
      // or capture a structured error for the tool_result. See
      // tool-args.ts for the cases (malformed JSON, non-object, etc.).
      const parsedArgs = parseToolArgs(call.function.arguments);
      let input: Record<string, unknown> = parsedArgs.ok ? parsedArgs.input : {};
      const argParseError: string | null = parsedArgs.ok ? null : parsedArgs.error;

      // Central coerce-then-validate against the tool's own inputSchema.
      // Safe repairs (string→number, "true"→true, scalar→array-wrap, …) are
      // applied to `input` here so the handler — and, for confirm-gated
      // tools, the pending queue — always sees the repaired args. Violations
      // only BLOCK below, inside the step, when the mode is 'enforce'.
      const argValidation: ValidateArgsResult | null =
        !argParseError && tool && argValidationMode !== 'off'
          ? validateToolArgs(
              (tool.inputSchema as Record<string, unknown> | null) ?? null,
              input,
              slug,
            )
          : null;
      if (argValidation) input = argValidation.input;

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
          // Arg-validation telemetry + (enforce-mode) rejection. The meta is
          // written in EVERY mode so /debug can chart repair + violation
          // rates per tool before anyone flips enforcement on.
          if (
            argValidation &&
            (argValidation.repairs.length > 0 ||
              argValidation.unknownKeys.length > 0 ||
              argValidation.violations.length > 0)
          ) {
            handle.setMeta({
              arg_validation: {
                mode: argValidationMode,
                ...(argValidation.repairs.length > 0 ? { repairs: argValidation.repairs } : {}),
                ...(argValidation.unknownKeys.length > 0
                  ? { unknown_keys: argValidation.unknownKeys }
                  : {}),
                ...(argValidation.violations.length > 0
                  ? { violations: argValidation.violations.map((v) => v.message) }
                  : {}),
              },
            });
          }
          if (argValidationMode === 'enforce' && argValidation?.error) {
            handle.setError(argValidation.error);
            return { ok: false as const, error: argValidation.error };
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
                    // Forward the parent's resolved (pre-clamp) budget so a
                    // delegated specialist inherits the per-user thinking pref.
                    ...(args.thinkingBudget ? { thinkingBudget: args.thinkingBudget } : {}),
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
        // Failure-aware guard accounting: identical failing calls escalate —
        // the payload teaches from the 2nd failure, the guard above blocks
        // at the limit.
        const failures = (exactFailureCounts.get(signature) ?? 0) + 1;
        exactFailureCounts.set(signature, failures);
        // Error strings can embed EXTERNAL content (an HTTP body excerpt, a
        // recipe step's inner error) and bypass the success-path fence below
        // — sanitize centrally so no handler has to remember to.
        payload = JSON.stringify({
          error: sanitizeToolError(outcome.error),
          ...(failures >= 2
            ? {
                loop_guard:
                  `This exact call has now failed ${failures} times this turn with the same ` +
                  `arguments. Change the arguments or the approach — after ` +
                  `${REPEATED_FAILURE_LIMIT} identical failures further attempts are blocked.`,
              }
            : {}),
        });
      } else {
        let serialized = JSON.stringify(outcome.output);
        // No-progress accounting: consecutive identical results for the same
        // signature. A different result resets the streak — re-reads after
        // writes legitimately repeat and are never penalised.
        {
          const resultHash = hashToolResult(serialized);
          const prior = identicalResults.get(signature);
          identicalResults.set(
            signature,
            prior && prior.hash === resultHash
              ? { hash: resultHash, count: prior.count + 1 }
              : { hash: resultHash, count: 1 },
          );
        }
        // Fence untrusted external content BEFORE the inline/spill decision so
        // the boundary travels both paths: inline results carry it directly,
        // and spilled results are stored fenced — so read_result page/grep/
        // query return fenced content too, never a clean instruction.
        if (
          UNTRUSTED_CONTENT_TOOL_SLUGS.has(slug) ||
          (outcome as { untrusted?: boolean }).untrusted === true
        ) {
          serialized = fenceRetrieved(serialized);
        }
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
    // Per-turn tool budget check at the BATCH boundary (never mid-batch —
    // see the snapshot above). Budget spent → stop looping; the force-final
    // pass below produces the answer. The explicit nudge tells the model the
    // budget (not its own judgment) ended the turn, so it reports honestly
    // what completed vs what remains instead of narrating false completion.
    if (totalToolCalls >= maxToolCallsPerTurn) budgetExhausted = true;
    if (budgetExhausted) {
      messages.push({
        role: 'user',
        content:
          `[system] This turn's tool-call budget (${maxToolCallsPerTurn}) is spent — no more tool calls ` +
          `will run this turn. ${formatOutcomeSummary(summarizeToolOutcomes(toolCalls))} ` +
          `Give your final answer now: state plainly what was completed (per the record above) and what ` +
          `remains to be done. Do not claim unfinished work is done. The user can ` +
          `send another message to continue where you left off.`,
      });
      break;
    }
  }

  // Loop exhausted without a final text response. Last message is a
  // tool result; force one more answer-only call so we don't return
  // nothing. This is a safety net — typical conversations finish well
  // under maxIters.
  //
  // Max-iters path only (the budget path pushed its own nudge above): give
  // the model the deterministic outcome ledger so its forced answer reports
  // what ACTUALLY completed rather than what it remembers attempting.
  if (!budgetExhausted && toolCalls.length > 0) {
    messages.push({
      role: 'user',
      content:
        `[system] The iteration limit was reached — no more tool calls will run this turn. ` +
        `${formatOutcomeSummary(summarizeToolOutcomes(toolCalls))} ` +
        `Answer now with what you have; do not claim unfinished work is done.`,
    });
  }
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
        reason: budgetExhausted ? 'tool_budget_reached' : 'max_iters_reached',
        ...(failedOver ? { failed_over: true } : {}),
      },
    },
    async (h) => {
      const r = await dispatchChat(active.adapter, {
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
      }, maxIters);
      recordChatUsage(h, r, active.model);
      tokensOut += r.tokensOut ?? 0;
      return r;
    },
  );
  let text = finalResult.text;
  if (!text.trim()) text = await retryEmptyReply('force_final_empty');
  messages.push({ role: 'assistant', content: text });
  return { reply: text, messages, iterations: maxIters + 1, toolCalls, pendingIds, artifacts, tokensOut };
}
