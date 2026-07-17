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
  toolCalls: ReadonlyArray<{ slug: string; argsJson: string; durationMs: number }>,
): Array<{ kind: string; label: string; elapsedMs?: number }> {
  const out: Array<{ kind: string; label: string; elapsedMs?: number }> = [];
  toolCalls.forEach((tc, i) => {
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

export type ResponderLoopResult = {
  /** The raw tool-loop outcome (artifacts, tokensOut, messages, …). */
  loop: ToolLoopResult;
  /** The reply text after the empty-reply fallback — NOT audio-tag-stripped;
   *  voice surfaces need the tags, text surfaces strip them at delivery. */
  reply: string;
  emptyReplySubstituted: boolean;
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
  if (!stopped && !reply.trim()) {
    console.error(
      `${opts.logPrefix} empty reply from model after retry (agent ${agent.slug}, ` +
        `${loop.iterations} iterations, ${loop.toolCalls.length} tool calls) — ` +
        'substituting fallback reply',
    );
    reply = EMPTY_REPLY_FALLBACK;
    emptyReplySubstituted = true;
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

  return { loop, reply, emptyReplySubstituted, persistedThoughts, toolStats, ctx };
}
