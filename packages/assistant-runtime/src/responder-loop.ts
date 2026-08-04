/**
 * Shared responder-loop CORE (audit #5c stage 2) — the traced middle of one
 * conversational turn, between "inbound persisted" and "deliver/persist the
 * reply". All three surfaces (web /assistant, Telegram, Team Chat) run this
 * one implementation:
 *
 *   load_context step (retrieval snapshot for /debug/context)
 *     → build messages (caller-supplied, so each surface keeps its own
 *       prompt-shape + any surface steps like Telegram's build_messages)
 *     → runToolLoop (params/keys/budgets from the stage-1 assembly)
 *     → post-loop bookkeeping: empty-reply fallback (b3), the persistable
 *       thought trail (b4), the deterministic tool-outcome ledger (b5)
 *
 * Runs INSIDE the caller's trace — the caller owns startTrace, because trace
 * shape is a surface decision: web/team open one trace per loop attempt
 * (a failed image attempt stays its own 'error' trace); Telegram wraps its
 * whole turn (transcription → send → persist) in a single trace. Persistence
 * and delivery stay sibling adapters (see run-team-turn.ts's header).
 */

import type { Agent, AgentParams } from '@mantle/db';
import {
  resolveBackupAdapter,
  runToolLoop,
  summarizeToolOutcomes,
  type ChatMessage,
  type ConversationContext,
  type ToolLoopArgs,
  type ToolLoopResult,
} from '@mantle/agent-runtime';
import {
  isPersistThoughtsEnabled,
  isStreamThoughtsEnabled,
  type ProfilePreferences,
} from '@mantle/content';
import { step } from '@mantle/tracing';
import { stageLabelForStep } from './stage-label';
import type { AssembledResponderTurn } from './assemble-turn';

/** Rebuild the persistable thought trail from a turn's tool calls — the same
 *  grounded action labels the live trail shows (search/write/delegate), via the
 *  shared `stageLabelForStep`. Thinking rounds aren't tool calls, so the result
 *  is exactly the "real actions" set the record displays. Returns [] when no
 *  call maps to a recognised stage. */
export function buildPersistedTrail(
  toolCalls: ReadonlyArray<{ slug: string; argsJson: string; durationMs: number; error?: string }>,
): Array<{ kind: string; label: string; elapsedMs?: number }> {
  const out: Array<{ kind: string; label: string; elapsedMs?: number }> = [];
  toolCalls.forEach((tc, i) => {
    // Calls cancelled by a user Stop never ran — recording them as performed
    // actions would put fabricated work in the frozen trail.
    if (tc.error === 'cancelled_by_user') return;
    let parsed: Record<string, unknown> = {};
    try {
      const p = JSON.parse(tc.argsJson) as unknown;
      if (p && typeof p === 'object') parsed = p as Record<string, unknown>;
    } catch {
      /* unparseable args — the label just won't be enriched */
    }
    const stage = stageLabelForStep(`tool: ${tc.slug}`, { args: parsed }, i);
    if (stage && stage.kind !== 'thinking') {
      out.push({ kind: stage.kind, label: stage.label, elapsedMs: tc.durationMs });
    }
  });
  return out;
}

/** The honest fallback when the model returns an empty final response twice
 *  (the tool loop already retried once — see retryEmptyReply in tool-loop.ts).
 *  Failing the whole turn after the inbound row persisted is worse than a
 *  reply the user can react to. One string for every surface. */
export const EMPTY_REPLY_FALLBACK =
  "Sorry — I gathered some information but couldn't compose a final answer " +
  '(the model returned an empty response twice). Please ask that again, ' +
  'perhaps more narrowly.';

/** Shown when the provider WITHHELD the reply on a policy rule rather than
 *  failing to produce one. Distinct from EMPTY_REPLY_FALLBACK because the
 *  advice differs: "ask again more narrowly" is wrong here — a re-ask of the
 *  same question gets blocked the same way. Naming the cause also stops a
 *  content block reading as a Mantle bug. */
export const BLOCKED_REPLY_FALLBACK =
  "Sorry — the model provider blocked its own response to that, so there's " +
  'nothing for me to show you. This was a safety filter on their side, not an ' +
  'error in your request. Rephrasing usually helps.';

/** Appended when the model hit its output-token ceiling mid-sentence. The reply
 *  is kept in full and the note is added, because a truncated answer that
 *  announces itself is far more useful than one that just stops. */
export const TRUNCATED_REPLY_NOTE =
  '\n\n_(Cut off — I hit my output length limit. Ask me to continue and I’ll ' +
  'pick up where this stops.)_';

export type ResponderLoopResult = {
  /** The raw tool-loop outcome (artifacts, tokensOut, messages, …). */
  loop: ToolLoopResult;
  /** The reply text after the empty-reply fallback — NOT audio-tag-stripped;
   *  voice surfaces need the tags, text surfaces strip them at delivery. */
  reply: string;
  emptyReplySubstituted: boolean;
  /** True when the empty reply was a provider CONTENT BLOCK rather than a
   *  model fumble — `reply` carries BLOCKED_REPLY_FALLBACK. Implies
   *  `emptyReplySubstituted`; surfaces can use it to distinguish "refused"
   *  from "failed" without re-deriving it from the text. */
  blockedByProvider: boolean;
  /** True when the model hit its output-token ceiling — `reply` is the full
   *  partial answer plus TRUNCATED_REPLY_NOTE. */
  truncated: boolean;
  /** Grounded action labels for the turn record (b4) — [] unless the owner
   *  has live streaming AND persistence on (Settings → Profile). */
  persistedThoughts: Array<{ kind: string; label: string; elapsedMs?: number }>;
  /** Deterministic tool-outcome ledger (b5) — the runtime's own account of
   *  "12 calls, 2 failed", independent of the reply's claims. Null when no
   *  tool ran. */
  toolStats: ReturnType<typeof summarizeToolOutcomes> | null;
  /** The loaded retrieval context, for callers that log or reuse it. */
  ctx: ConversationContext;
};

/** A zeroed loop result for the abort path — a user Stop can surface as an
 *  AbortError instead of a graceful partial; callers synthesize this so the
 *  turn finalizes 'complete' rather than 'failed'. */
export function emptyLoopResult(): ToolLoopResult {
  return {
    reply: '',
    messages: [],
    iterations: 0,
    toolCalls: [],
    pendingIds: [],
    artifacts: [],
    tokensOut: 0,
  };
}

export type RunResponderLoopOptions = {
  ownerId: string;
  agent: Agent;
  /** Pre-resolved chat adapter for the agent's provider. Resolved by the
   *  caller (before its trace opens) so a missing adapter fails with the
   *  surface's own error message and no half-open trace. */
  adapter: ToolLoopArgs['adapter'];
  apiKey: string;
  prefs: ProfilePreferences;
  logPrefix: string;
  /** The stage-1 assembly: tools, budgets, delegation, loop overrides. */
  assembled: AssembledResponderTurn;
  /** Load (or return the pre-loaded) retrieval context. Runs inside the
   *  load_context step. Callers that may run the loop twice (image retry)
   *  should memoize so retrieval isn't re-paid. */
  loadContext: () => Promise<ConversationContext>;
  /** Extra fields for the load_context step's input (team adds contactId). */
  contextStepInput?: Record<string, unknown>;
  /** Merged over the step's standard output — team overrides `turnCount`
   *  with its own thread length (its ctx history is structurally empty). */
  contextStepExtra?: Record<string, unknown>;
  /** Build the prompt messages from the loaded context. Surface-owned so
   *  each keeps its exact prompt shape (and Telegram its build_messages
   *  step). */
  buildMessages: (ctx: ConversationContext) => Promise<ChatMessage[]> | ChatMessage[];
  /** Threaded into every tool handler's ctx.surface (delivery targeting +
   *  provenance). */
  surface: ToolLoopArgs['surface'];
  /** The per-turn abort signal, when the surface supports Stop. An aborted
   *  turn keeps its partial reply — no fallback substitution. */
  abortSignal?: AbortSignal | null;
};

/**
 * Run the shared middle of one responder turn inside the caller's trace.
 * Everything before (inbound persistence, transcription, attachment ingest)
 * and after (delivery, outbound persistence) stays in the surface adapter.
 */
export async function runResponderLoop(
  opts: RunResponderLoopOptions,
): Promise<ResponderLoopResult> {
  const { agent, assembled } = opts;

  // Persist the retrieval snapshot as a 'load_context' step — what
  // /debug/context renders per turn (items, distances, near-misses). Callers
  // that pre-loaded the context pass a thunk returning it; the step then just
  // records the snapshot.
  const ctx = await step(
    {
      name: 'load_context',
      kind: 'compute',
      input: opts.contextStepInput ?? { agentId: agent.id },
    },
    async (h) => {
      const c = await opts.loadContext();
      h.setOutput({
        turnCount: c.history.length,
        digestCount: c.digests.length,
        factCount: c.facts.length,
        contentHitCount: c.contentHits.length,
        chunkHitCount: c.chunkHits.length,
        corpusMapCount: c.corpusMap.entries.length,
        relationCount: c.relations.length,
        personaNoteCount: c.personaNotes.length,
        // Full retrieval audit record (items + distances + near-misses).
        snapshot: c.snapshot,
        ...(opts.contextStepExtra ?? {}),
      });
      return c;
    },
  );

  const loop = await runToolLoop({
    adapter: opts.adapter,
    apiKey: opts.apiKey,
    model: agent.model,
    baseUrl: agent.baseUrl,
    viaTailnet: agent.viaTailnet,
    backup: await resolveBackupAdapter(opts.ownerId, agent),
    params: (agent.params ?? {}) as AgentParams,
    ownerId: opts.ownerId,
    agentId: agent.id,
    agentSlug: agent.slug,
    agentDepth: 1,
    delegateTo: assembled.delegateTo,
    resultHandling: assembled.resultHandling,
    thinkingBudget: assembled.thinkingBudget,
    thinkingEffort: assembled.thinkingEffort,
    ...assembled.loopOverrides,
    initialMessages: await opts.buildMessages(ctx),
    tools: assembled.allowedTools,
    surface: opts.surface,
  });

  // A user Stop ends the turn with whatever partial reply streamed (often
  // empty) — never substitute over it.
  const stopped = opts.abortSignal?.aborted === true;
  let reply = loop.reply;
  let emptyReplySubstituted = false;
  let blockedByProvider = false;
  let truncated = false;
  if (!stopped && !reply.trim()) {
    // Two different empties. A provider content block is not a model fumble,
    // and telling the user to "ask more narrowly" would be actively misleading
    // advice — so it gets its own message and its own log line.
    blockedByProvider = loop.finishReason === 'content_filter';
    console.error(
      `${opts.logPrefix} ${blockedByProvider ? 'reply blocked by provider' : 'empty reply from model after retry'} ` +
        `(agent ${agent.slug}, ${loop.iterations} iterations, ` +
        `${loop.toolCalls.length} tool calls) — substituting fallback reply`,
    );
    reply = blockedByProvider ? BLOCKED_REPLY_FALLBACK : EMPTY_REPLY_FALLBACK;
    emptyReplySubstituted = true;
  } else if (!stopped && loop.finishReason === 'length') {
    // Non-empty but cut off at the token ceiling. Keep every word the model
    // produced and mark it, so the user knows the thought is unfinished rather
    // than assuming the assistant simply stopped there.
    truncated = true;
    console.warn(
      `${opts.logPrefix} reply truncated at the output-token limit (agent ${agent.slug}, ` +
        `${loop.iterations} iterations, ${loop.tokensOut} output tokens)`,
    );
    reply = reply.trimEnd() + TRUNCATED_REPLY_NOTE;
  }

  // Thought trail (b4): grounded action labels rebuilt from this turn's tool
  // calls, persisted only when the brain has live streaming AND persistence
  // on (Settings → Profile). A turn with no recognised actions persists
  // nothing (no empty record).
  const persistedThoughts =
    isStreamThoughtsEnabled(opts.prefs) && isPersistThoughtsEnabled(opts.prefs)
      ? buildPersistedTrail(loop.toolCalls)
      : [];
  // Tool-outcome ledger (b5): persisted whenever any tool ran, independent of
  // the thoughts-persistence preference.
  const toolStats = loop.toolCalls.length > 0 ? summarizeToolOutcomes(loop.toolCalls) : null;

  return {
    loop,
    reply,
    emptyReplySubstituted,
    blockedByProvider,
    truncated,
    persistedThoughts,
    toolStats,
    ctx,
  };
}
