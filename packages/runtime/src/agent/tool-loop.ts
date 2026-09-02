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

import { step, currentTurnAbortSignal } from '@mantle/tracing';
import {
  resolveTool,
  resolveTools,
  resolveResultHandling,
  validateToolArgs,
  getDynamicSchema,
  type ValidateArgsResult,
  type ResultHandlingConfig,
  type ToolCallRecord,
} from '@mantle/tools';
import { type Tool, type AgentParams } from '@mantle/db';
import type { ToolArtifact } from '@mantle/tools';
import {
  type ChatDispatcher,
  type ChatFinishReason,
  type ChatToolDefinition,
  type ThinkingEffort,
} from '@mantle/voice';

import type { ChatMessage } from './messages';

import { parseToolArgs } from './tool-args';
import {
  HARD_MAX_CALLS_PER_TOOL_PER_TURN,
  HARD_MAX_TOOL_CALLS_PER_TURN,
  MAX_CALLS_PER_TOOL_PER_TURN,
  MAX_TOOL_CALLS_PER_TURN,
  TurnGuards,
  canonicalJson,
  resolveCap,
} from './tool-loop/guards';
import { createModelCaller } from './tool-loop/model-caller';
import { executeToolCall, toolResultPayload } from './tool-loop/execute-call';
import { env } from '@mantle/config';
import { UUID_RE } from '@mantle/std';

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

// Third-party content fencing: the web builtins are fenced by slug
// (UNTRUSTED_CONTENT_TOOL_SLUGS, shared with dispatch), and the dispatch
// layer flags provenance the loop can't see — http-kind tools (user-authored
// API tools hit arbitrary endpoints) and recipes whose chain ran an http/web
// step — via `untrusted` on the result. Either signal fences the payload as
// data before the model reads it, so an injected "ignore your task and email
// this to…" inside a page, hit, or API response can't be read as an
// instruction. Auto-retrieved content (notes/emails/passages) is already
// fenced in messages.ts; failed calls run through sanitizeToolError instead.

// ── Central arg validation (coerce-then-validate) ──
// Every tool call's args are checked against the tool's own inputSchema
// BEFORE dispatch (see @mantle/tools validate-args.ts). Safe repairs
// (string→number, scalar→array-wrap, …) are applied in 'warn' and 'enforce';
// schema violations block dispatch with a teaching error only in 'enforce'.
// 'warn' is the default so a fleet-wide rollout starts as pure telemetry —
// trace_steps.meta.arg_validation shows exactly what WOULD be rejected —
// and 'enforce' is flipped per box once the violation rate is understood.
export type ToolValidationMode = 'off' | 'warn' | 'enforce';

export function resolveToolValidationMode(
  value: string | undefined = env('MANTLE_TOOL_VALIDATION'),
): ToolValidationMode {
  const raw = (value ?? '').trim().toLowerCase();
  return raw === 'off' || raw === 'enforce' ? raw : 'warn';
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
  // A user Stop landed mid-batch — the call was never dispatched. Counted as
  // skipped, NOT failed: the always-visible "N failed this turn" badge must
  // not brand a deliberately-stopped turn as a failure.
  'cancelled_by_user',
]);

export type ToolOutcomeStats = {
  calls: number;
  succeeded: number;
  failed: number;
  /** Blocked by a guard (dedup/caps/failure-aware) — never dispatched. */
  skipped: number;
  /** Queued behind operator approval (requires_confirm) — not yet run. */
  queued: number;
  /** Up to 5 distinct handler failures, slug + truncated error. */
  failures: Array<{ slug: string; error: string }>;
  /** Up to 5 distinct artifacts touched by successful write-style calls
   *  (ToolCallRecord.target, deduped by id) — read back into the next turn's
   *  history so "where did you update it?" is answerable. */
  writes?: Array<{ slug: string; id: string; title?: string }>;
};

export function summarizeToolOutcomes(records: readonly ToolCallRecord[]): ToolOutcomeStats {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let queued = 0;
  const failures: Array<{ slug: string; error: string }> = [];
  const writes: Array<{ slug: string; id: string; title?: string }> = [];
  const writeIds = new Set<string>();
  for (const r of records) {
    if (r.error === 'queued_for_approval') {
      queued++;
    } else if (r.status === 'success') {
      succeeded++;
      if (r.target && writes.length < 5 && !writeIds.has(r.target.id)) {
        writeIds.add(r.target.id);
        writes.push({
          slug: r.slug,
          id: r.target.id,
          ...(r.target.title ? { title: r.target.title } : {}),
        });
      }
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
  return {
    calls: records.length,
    succeeded,
    failed,
    skipped,
    queued,
    failures,
    ...(writes.length > 0 ? { writes } : {}),
  };
}

// ── Write-target capture ──
// There is no mutation flag on tool rows, so write-style calls are recognised
// by slug verb (the builtin naming convention is consistent: page_create,
// table_row_add, page_update_draft, …). A miss just means no target is
// recorded — never a wrong claim, since the id/title come from the tool's own
// success output.
const WRITE_VERBS = new Set([
  'create',
  'update',
  'add',
  'set',
  'delete',
  'commit',
  'move',
  'rename',
  'upsert',
  'apply',
  'split',
  'replace',
  'edit',
  'send',
  'share',
  'unshare',
  'upload',
  'insert',
]);

/** True when any underscore segment of the slug is a write verb
 *  (`table_row_add` → add, `page_update_draft` → update). */
export function looksLikeWriteTool(slug: string): boolean {
  return slug.split('_').some((seg) => WRITE_VERBS.has(seg));
}

/** Pull `{id, title}` out of a successful write tool's output. Builtins return
 *  the touched artifact at the top level (`{id, url, title}`) or under
 *  `output`; only a UUID-shaped id is accepted so prose fields can't leak in. */
export function extractWriteTarget(output: unknown): { id: string; title?: string } | null {
  if (output === null || typeof output !== 'object') return null;
  const rec = output as Record<string, unknown>;
  const id = typeof rec.id === 'string' && UUID_RE.test(rec.id) ? rec.id : null;
  if (!id) return null;
  const title =
    typeof rec.title === 'string' && rec.title.trim()
      ? rec.title.trim().slice(0, 80)
      : typeof rec.name === 'string' && rec.name.trim()
        ? rec.name.trim().slice(0, 80)
        : undefined;
  return { id, ...(title ? { title } : {}) };
}

/** One-line rendering of the stats for the model-facing nudges. */
function formatOutcomeSummary(stats: ToolOutcomeStats): string {
  const parts = [`${stats.succeeded} succeeded`];
  if (stats.failed > 0) parts.push(`${stats.failed} FAILED`);
  if (stats.queued > 0) {
    parts.push(`${stats.queued} queued for operator approval (NOT yet run)`);
  }
  if (stats.skipped > 0) parts.push(`${stats.skipped} blocked by guards (never ran)`);
  let line = `Tool-call record for this turn (runtime ledger, not memory): ${stats.calls} issued — ${parts.join(', ')}.`;
  if (stats.failures.length > 0) {
    line += ` Failed: ` + stats.failures.map((f) => `${f.slug} (${f.error})`).join('; ') + `.`;
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
  /** Why the FINAL model round stopped, when the adapter reported it.
   *  Undefined means the provider said nothing — not that it finished
   *  cleanly. Only the last round is carried: an intermediate round always
   *  stops for `tool_calls`, which says nothing about the answer the user
   *  ends up seeing.
   *
   *  The two values callers act on are `'length'` (the reply is cut off
   *  mid-thought) and `'content_filter'` (the provider withheld it). Both
   *  otherwise arrive as an ordinary successful turn. */
  finishReason?: ChatFinishReason;
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
  /** Thinking EFFORT tier — the control the providers actually honour (see
   *  ChatOptions.thinkingEffort). Travels alongside `thinkingBudget`: the budget
   *  still drives the max_tokens headroom maths and the Anthropic-direct on/off
   *  signal, while this is what OpenRouter puts on the wire. Undefined ⇒ no
   *  reasoning requested. */
  thinkingEffort?: ThinkingEffort;
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
export async function resolveAgentTools(ownerId: string, slugs: string[]): Promise<Tool[]> {
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
      let parameters = (t.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      };
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

  const messages: ChatMessage[] = [...args.initialMessages];
  // The turn's latest USER message — threaded to handlers via ctx.agent so
  // invoke_agent can attach the user's verbatim ask to a delegation (the
  // child sees only the packed prompt; this closes the under-packing gap).
  const lastUserTurn = [...args.initialMessages].reverse().find((m) => m.role === 'user');
  const lastUserMessage =
    typeof lastUserTurn?.content === 'string'
      ? lastUserTurn.content
      : Array.isArray(lastUserTurn?.content)
        ? lastUserTurn.content
            .filter((p): p is { type: 'text'; text: string } => p?.type === 'text')
            .map((p) => p.text)
            .join('\n')
        : undefined;
  const toolCalls: ToolCallRecord[] = [];
  const pendingIds: string[] = [];
  // Sidecar artifacts (audio bytes, image bytes) collected across
  // every handler invocation in this loop. Surfaced in the
  // ToolLoopResult for callers that want to render them inline
  // (web /assistant). Telegram-path tools deliver via their own
  // send* calls and don't populate this.
  const artifacts: ToolArtifact[] = [];

  // True once the user hit Stop (the turn's AbortController fired). The signal
  // is already threaded into every LLM call (dispatchChat) so generation
  // halts; these loop-level checks are what stop the REST of the turn — tool
  // execution and further rounds — which otherwise ran to completion after a
  // Stop (the "stop doesn't stop it" bug). Delegated sub-agents run this same
  // loop with the same turnId, so they inherit every check.
  const turnAborted = () => currentTurnAbortSignal()?.aborted === true;

  // Every LLM round of this turn runs through one caller that owns the active
  // route (sticky primary→backup failover) and the output-token total.
  const model = createModelCaller({ args, messages, toolsForModel, turnAborted });

  // Tool-volume + failure-aware guards (see tool-loop/guards.ts). Turn-scoped:
  // the budget is cumulative across rounds; per-tool counts catch single-tool
  // fixation even when the model varies the args to slip past the in-response
  // dedup.
  const guards = new TurnGuards({
    maxToolCallsPerTurn: resolveCap(
      args.maxToolCallsPerTurn,
      MAX_TOOL_CALLS_PER_TURN,
      HARD_MAX_TOOL_CALLS_PER_TURN,
    ),
    maxCallsPerToolPerTurn: resolveCap(
      args.maxCallsPerToolPerTurn,
      MAX_CALLS_PER_TOOL_PER_TURN,
      HARD_MAX_CALLS_PER_TOOL_PER_TURN,
    ),
  });
  // Resolved once per turn: schemas (and therefore what counts as a
  // violation) are frozen for the turn, so the mode should be too.
  const argValidationMode = resolveToolValidationMode();
  // A response whose tool calls were ALL guard-skipped (≥3 of them) forces the
  // final answer — see the batch-boundary check below.
  let batchFullySkipped = false;

  // Skip a tool call WITHOUT executing it, still emitting the synthetic
  // tool_result the provider protocol requires (every tool_call needs a paired
  // result) plus a trace step. Used by the guards and by a user Stop.
  const skipToolCall = async (
    call: { id: string; function: { name: string; arguments: string } },
    reason: string,
    note: string,
    firstCallId?: string,
  ): Promise<void> => {
    const slug = call.function.name;
    const argsRaw = call.function.arguments ?? '{}';
    // Guard skips get a trace step; a user-cancelled skip does NOT — the step
    // observer publishes a "doing X" trail line on step START, so tracing a
    // batch of cancelled calls would paint new activity AFTER the user hit
    // Stop. The ledger entry + paired tool message below are record enough.
    if (reason !== 'cancelled_by_user') {
      await step(
        {
          name: `tool: ${slug}`,
          kind: 'compute',
          input: {
            slug,
            args: firstCallId !== undefined ? '<duplicate, suppressed>' : '<capped, suppressed>',
          },
        },
        async (handle) => {
          handle.setSkipped(reason);
          // `model` is denormalised onto the suppression step's meta so the
          // /debug "duplicates suppressed by model" widget can group by it
          // without a lateral join back to the trace's first llm_call step.
          handle.setMeta(
            firstCallId !== undefined
              ? { [reason]: true, first_call_id: firstCallId, call_id: call.id, model: args.model }
              : { [reason]: true, call_id: call.id, model: args.model },
          );
        },
      );
    }
    toolCalls.push({ slug, argsJson: argsRaw, durationMs: 0, status: 'error', error: reason });
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: JSON.stringify(
        firstCallId !== undefined
          ? { ok: false, error: reason, note, first_call_id: firstCallId }
          : { ok: false, error: reason, note },
      ),
    });
  };

  // The last round's non-empty commentary, kept so a Stop that lands in a
  // round whose own text is empty (models usually emit tool calls without
  // prose) still finalizes with the text the user was READING — otherwise
  // reconcile replaces the visible streamed text with a blank durable reply.
  let lastRoundText = '';

  /** Finalize a stopped turn with the round's partial text (falling back to
   *  the last non-empty round's text). The caller (runResponderLoop →
   *  run-turn) sees the aborted signal and keeps this reply verbatim — it
   *  deliberately does NOT substitute its empty-reply fallback for stops.
   *  `pushAssistantMessage` is false when the round's text already sits in
   *  the transcript (the tool_calls assistant message) — a second push would
   *  duplicate it for any future consumer of `messages`. */
  const stoppedResult = (
    text: string,
    iter: number,
    opts: { pushAssistantMessage: boolean } = { pushAssistantMessage: true },
  ): ToolLoopResult => {
    const reply = text.trim() ? text : lastRoundText;
    if (opts.pushAssistantMessage) messages.push({ role: 'assistant', content: reply });
    return {
      reply,
      messages,
      iterations: iter + 1,
      toolCalls,
      pendingIds,
      artifacts,
      tokensOut: model.tokensOut,
    };
  };

  for (let iter = 0; iter < maxIters; iter++) {
    const result = await model.round(iter);

    if (result.text.trim()) lastRoundText = result.text;

    // User Stop landed during (or just before) this round: the adapter
    // returned its partial reply instead of throwing. DISCARD any complete
    // tool calls the partial carried and finalize with the partial text —
    // executing them would keep the turn visibly running after the Stop.
    if (turnAborted()) return stoppedResult(result.text, iter);

    const calls = result.toolCalls;

    if (!calls || calls.length === 0) {
      // Final text response. Done.
      let text = result.text;
      // An empty reply usually means the model fumbled, and one nudge fixes it.
      // A content_filter block is the exception: the provider withheld the text
      // deliberately, so re-asking spends a second call to be refused again.
      // Skip the retry there and let the caller degrade with an honest message.
      const blocked = result.finishReason === 'content_filter';
      if (!text.trim() && !turnAborted() && !blocked) {
        text = await model.retryEmpty('final_round_empty');
      }
      messages.push({ role: 'assistant', content: text });
      return {
        reply: text,
        messages,
        iterations: iter + 1,
        toolCalls,
        pendingIds,
        artifacts,
        tokensOut: model.tokensOut,
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      };
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

    // Execute each call, append tool message. The guards decide, in a fixed
    // order, which calls run (see TurnGuards); every skipped call still gets
    // its paired synthetic result.
    guards.beginBatch();
    for (const call of calls) {
      // Stop mid-batch: nothing new starts. Each remaining call still gets a
      // paired synthetic result (providers reject an unpaired tool_use on any
      // later request); the post-batch check below finalizes the turn.
      if (turnAborted()) {
        await skipToolCall(
          call,
          'cancelled_by_user',
          'The user stopped this turn before this call ran. It was not executed; do not retry it.',
        );
        continue;
      }
      const startedAt = Date.now();
      const slug = call.function.name;
      const argsRaw = call.function.arguments ?? '{}';
      const pre = guards.preParse({ id: call.id, slug, argsRaw });
      if (pre) {
        await skipToolCall(call, pre.reason, pre.note, pre.firstCallId);
        continue;
      }
      const tool = toolsByName.get(slug);
      // Parse the LLM-supplied arguments string into a JSON object,
      // or capture a structured error for the tool_result. See
      // tool-args.ts for the cases (malformed JSON, non-object, etc.).
      // Parsed BEFORE the failure-aware guards so their signature can be
      // canonical (post-repair, sorted keys) — pure work, no side effects.
      const parsedArgs = parseToolArgs(call.function.arguments);
      let input: Record<string, unknown> = parsedArgs.ok ? parsedArgs.input : {};
      const argParseError: string | null = parsedArgs.ok ? null : parsedArgs.error;

      // Central coerce-then-validate against the tool's own inputSchema.
      // Safe repairs (string→number, "true"→true, scalar→array-wrap, …) are
      // applied to `input` here so the handler — and, for confirm-gated
      // tools, the pending queue — always sees the repaired args. Violations
      // only BLOCK inside the step, when the mode is 'enforce'.
      const argValidation: ValidateArgsResult | null =
        !argParseError && tool && argValidationMode !== 'off'
          ? validateToolArgs(
              (tool.inputSchema as Record<string, unknown> | null) ?? null,
              input,
              slug,
            )
          : null;
      if (argValidation) input = argValidation.input;

      // Keyed by the CANONICAL signature — post-repair args with sorted
      // keys — so `{"limit":"25"}` and `{"limit":25}` (and key-order
      // shuffles) count as the same call. The raw-string signature the
      // in-response dedup uses is byte-identity on purpose.
      const guardSig = `${slug}::${argParseError ? argsRaw : canonicalJson(input)}`;
      const post = guards.postParse(slug, guardSig);
      if (post) {
        await skipToolCall(call, post.reason, post.note);
        continue;
      }
      guards.admit(slug);

      const outcome = await executeToolCall({
        args,
        slug,
        call,
        tool,
        input,
        argParseError,
        argValidation,
        argValidationMode,
        lastUserMessage,
        pendingIds,
      });

      const duration = Date.now() - startedAt;
      // A confirm-gated call returns ok:true (the QUEUING succeeded) but the
      // tool itself hasn't run — record it as its own outcome so the ledger
      // never reports a pending action as done.
      const queuedForApproval =
        outcome.ok &&
        outcome.output !== null &&
        typeof outcome.output === 'object' &&
        (outcome.output as { status?: unknown }).status === 'queued_for_approval';
      const writeTarget =
        outcome.ok && !queuedForApproval && looksLikeWriteTool(slug)
          ? extractWriteTarget(outcome.output)
          : null;
      toolCalls.push({
        slug,
        argsJson: call.function.arguments ?? '{}',
        durationMs: duration,
        status: queuedForApproval ? 'skipped' : outcome.ok ? 'success' : 'error',
        error: queuedForApproval ? 'queued_for_approval' : outcome.ok ? undefined : outcome.error,
        ...(writeTarget ? { target: writeTarget } : {}),
      });

      // Harvest any sidecar artifacts the tool emitted (audio bytes,
      // image bytes). These don't go into the LLM-visible result —
      // see ToolHandlerResult comment — they ride the
      // ToolLoopResult.artifacts list and the caller decides what
      // to do with them.
      if (outcome.ok && outcome.artifacts && outcome.artifacts.length > 0) {
        for (const a of outcome.artifacts) artifacts.push(a);
      }

      const payload = await toolResultPayload({
        outcome,
        slug,
        guardSig,
        guards,
        ownerId: args.ownerId,
        handling,
      });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: payload,
        // Tell cache-aware adapters this result is an error (the runtime
        // knows via outcome.ok) so they set the provider's is_error flag.
        ...(outcome.ok ? {} : { isError: true as const }),
      });
    }
    // Stop landed during the batch (possibly on its very last call, which the
    // per-call guard can't catch): finalize now instead of running another
    // round against an already-dead signal. The round's text is already in
    // the transcript (the tool_calls assistant message pushed above) — don't
    // push it twice.
    if (turnAborted()) return stoppedResult(result.text, iter, { pushAssistantMessage: false });
    const boundary = guards.endBatch(calls.length);
    if (boundary === 'batch_fully_skipped') {
      // (NATREF 2026-07-28: a capped child re-issued 47 blocked row-adds across
      // two more rounds before giving up.) Force the final answer now instead
      // of paying LLM rounds for more of the same.
      batchFullySkipped = true;
      messages.push({
        role: 'user',
        content:
          `[system] Every tool call in your last response (${calls.length} of them) was blocked ` +
          `by this turn's guards — none ran, and re-issuing them will not run either. ` +
          `${formatOutcomeSummary(summarizeToolOutcomes(toolCalls))} ` +
          `Give your final answer now: state plainly what completed (per the record above) and ` +
          `what remains, so your caller or the user can continue from there. Do not claim ` +
          `unfinished work is done.`,
      });
      break;
    }
    if (boundary === 'budget_exhausted') {
      // Budget spent → stop looping; the force-final pass below produces the
      // answer. The explicit nudge tells the model the budget (not its own
      // judgment) ended the turn, so it reports honestly what completed vs
      // what remains instead of narrating false completion.
      messages.push({
        role: 'user',
        content:
          `[system] This turn's tool-call budget (${guards.maxToolCallsPerTurn}) is spent — no more tool calls ` +
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
  if (!guards.budgetExhausted && !batchFullySkipped && toolCalls.length > 0) {
    messages.push({
      role: 'user',
      content:
        `[system] The iteration limit was reached — no more tool calls will run this turn. ` +
        `${formatOutcomeSummary(summarizeToolOutcomes(toolCalls))} ` +
        `Answer now with what you have; do not claim unfinished work is done.`,
    });
  }
  const finalResult = await model.forceFinal(
    guards.budgetExhausted
      ? 'tool_budget_reached'
      : batchFullySkipped
        ? 'batch_fully_skipped'
        : 'max_iters_reached',
    maxIters,
  );
  let text = finalResult.text;
  // Same reasoning as the normal exit above: a withheld reply won't un-withhold
  // itself on a second ask.
  const finalBlocked = finalResult.finishReason === 'content_filter';
  if (!text.trim() && !turnAborted() && !finalBlocked) {
    text = await model.retryEmpty('force_final_empty');
  }
  messages.push({ role: 'assistant', content: text });
  return {
    reply: text,
    messages,
    iterations: maxIters + 1,
    toolCalls,
    pendingIds,
    artifacts,
    tokensOut: model.tokensOut,
    ...(finalResult.finishReason ? { finishReason: finalResult.finishReason } : {}),
  };
}
