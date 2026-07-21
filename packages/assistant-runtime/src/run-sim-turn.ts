/**
 * Simulated responder turn — the REAL responder pipeline with NOTHING persisted
 * to the conversation store.
 *
 * This is "Agent Studio sandbox, but with the real tool loop". Where the Studio
 * sandbox (apps/web/app/api/studio/sandbox/route.ts) composes the prompt and
 * makes a single bare `adapter.chat()` call with tools + memory OFF, this runs
 * the full thing: composed persona prompt (identity + skills), real retrieval
 * context (facts, chunks, digests, persona notes, corpus map), real tool grants
 * from the agent's tool GROUPS, and REAL tool execution — including
 * `invoke_agent` delegation. The only thing it does NOT do is write:
 *
 *   - NO recordTurn (no inbound/outbound assistant_messages rows)
 *   - NO updateAssistantMessageOutcome
 *   - NO agents.lastUsedAt / usageCount bump
 *
 * So an MCP client (Claude Code / Desktop) can talk to a responder agent as if
 * it were the user, exercise the real behaviour, and leave the agent's
 * conversation history untouched. Tool SIDE EFFECTS still happen (a note gets
 * created, an email queues on /pending) — only the conversation record is
 * suppressed. Multi-turn is caller-held: the caller passes prior turns in
 * `history` and resends them each call.
 *
 * The turn runs inside its own trace (kind 'manual', subject the agent) so the
 * LLM call + every tool dispatch is visible in /traces, exactly like a real
 * turn — just not tied to an assistant_message row (there isn't one). The trace
 * id is returned so the MCP reply can link to it.
 *
 * Mirrors run-turn.ts's read path (agent resolution, prefs, api key, adapter,
 * pre-loaded context) minus every write. See run-turn.ts for the annotated
 * original.
 */

import { getApiKeyById } from '@mantle/api-keys';
import { buildChatMessages, loadConversationContext } from '@mantle/agent-runtime';
import { getChatAdapter } from '@mantle/voice';
import { loadProfilePreferences } from '@mantle/content';
import { startTrace, currentTrace } from '@mantle/tracing';
import { resolveAssistantAgent } from './run-turn';
import { assembleResponderTurn } from './assemble-turn';
import { runResponderLoop } from './responder-loop';

/** One caller-supplied prior turn. Shape matches an MCP client's chat log — the
 *  sim maps it onto the runtime's internal HistoryTurn ({ role, text }). */
export type SimHistoryTurn = { role: 'user' | 'assistant'; content: string };

/** A single tool call the responder made this turn (the runtime's own record —
 *  not the model's claims). Mirrors ToolCallRecord from the tool loop. */
export type SimToolCall = {
  slug: string;
  argsJson: string;
  durationMs: number;
  status: string;
  error?: string | null;
};

export type RunSimulatedResponderTurnOptions = {
  /** Which responder answers. Omit → the web-default responder (same pick a
   *  browser /assistant turn makes). */
  agentSlug?: string;
  /** The user's message for this turn. */
  message: string;
  /** Prior turns, caller-held. Used verbatim as the prompt's conversation
   *  history INSTEAD of the agent's stored assistant_messages — the sim reads
   *  no history from the store. */
  history?: SimHistoryTurn[];
  /** Slugs removed from the tool allowlist AFTER group resolution — lets the
   *  caller run the persona with a narrowed tool set. */
  excludeToolSlugs?: string[];
  /** Cap the tool-loop iteration ceiling for this turn. Clamped to a positive
   *  int ≤ 30 (matches the responder/delegation clamp). */
  maxIterations?: number;
  /** Hard wall-clock ceiling for the whole turn. Defaults to 5 minutes. */
  timeoutMs?: number;
};

export type RunSimulatedResponderTurnResult = {
  /** The composed reply (empty-reply fallback applied, audio tags NOT stripped —
   *  the caller decides; MCP surfaces render text). */
  reply: string;
  agent: { slug: string; model: string };
  /** The runtime's own account of every tool the turn ran. */
  toolCalls: SimToolCall[];
  /** Deterministic tool-outcome ledger ("N calls, M failed"), or null when no
   *  tool ran. */
  toolStats: unknown;
  /** Ids of confirm-gated tool calls parked on /pending this turn. */
  pendingIds: string[];
  /** The trace this turn opened, for a /traces link. */
  traceId: string | null;
  emptyReplySubstituted: boolean;
};

/** The tool-loop's abort-signal ceiling never runs longer than this even if a
 *  caller asks for more — a runaway MCP sim must not pin the process. */
const MAX_TIMEOUT_MS = 600_000;

/**
 * Run ONE real responder turn for `ownerId` and return the reply + tool trail
 * without writing anything to the conversation store. Throws the same shaped
 * errors as {@link runAssistantTurn} for a missing agent / missing api key.
 */
export async function runSimulatedResponderTurn(
  ownerId: string,
  opts: RunSimulatedResponderTurnOptions,
): Promise<RunSimulatedResponderTurnResult> {
  const message = opts.message.trim();
  if (!message) throw new Error('runSimulatedResponderTurn: empty message');

  const agent = await resolveAssistantAgent(ownerId, opts.agentSlug);
  if (!agent) {
    throw new Error(
      'No enabled assistant agent. Create one at /settings/agents (role=assistant or fallback responder).',
    );
  }
  if (!agent.apiKeyId) {
    throw new Error(`Agent '${agent.slug}' has no api_key_id set — edit at /settings/agents.`);
  }
  const apiKey = await getApiKeyById(agent.apiKeyId);
  if (!apiKey) {
    throw new Error(
      `api_key_id ${agent.apiKeyId} not found for agent '${agent.slug}' — was it deleted?`,
    );
  }

  const adapter = getChatAdapter(agent.provider);
  if (!adapter) {
    throw new Error(
      `mcp-sim: no chat adapter registered for provider '${agent.provider}' (agent ${agent.slug})`,
    );
  }

  const prefs = await loadProfilePreferences(ownerId);

  // Real retrieval — facts, chunks, digests, persona notes, corpus map — exactly
  // as a live turn loads it. We keep everything EXCEPT the loaded history: the
  // sim's conversation history is caller-held, so we build the prompt from
  // `opts.history` and never touch the stored assistant_messages window.
  const ctx = await loadConversationContext({ ownerId, agent, inboundText: message });
  const history = (opts.history ?? []).map((t) => ({
    role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    text: t.content,
  }));

  // Shared responder-turn assembly (identity + skills prompt, volatile context,
  // group-resolved tool allowlist, thinking budget, loop overrides). No
  // heartbeatSurface — the sim isn't a live web/telegram surface, so it skips
  // the open-heartbeat awareness block + continuity-tool affordance.
  const assembled = await assembleResponderTurn({
    ownerId,
    agent,
    prefs,
    logPrefix: '[mcp-sim]',
    ...(opts.excludeToolSlugs?.length ? { excludeToolSlugs: opts.excludeToolSlugs } : {}),
  });

  // Apply the caller's iteration cap by overriding the assembly's loop
  // overrides. Clamp to a positive int ≤ 30, matching assemble-turn's own
  // memory_config clamp — an unbounded ceiling from an MCP client is a footgun.
  if (typeof opts.maxIterations === 'number' && opts.maxIterations > 0) {
    assembled.loopOverrides = {
      ...assembled.loopOverrides,
      maxIterations: Math.min(30, Math.floor(opts.maxIterations)),
    };
  }

  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : 300_000,
  );

  let traceId: string | null = null;
  const outcome = await startTrace(
    {
      kind: 'manual',
      ownerId,
      subjectKind: 'agent',
      subjectId: agent.id,
      agentId: agent.id,
      data: {
        surface: 'mcp_sim',
        model: agent.model,
        agent_slug: agent.slug,
        tool_count: assembled.allowedTools.length,
      },
    },
    async () => {
      // Capture the trace id from inside the AsyncLocalStorage scope (startTrace
      // doesn't return it) so the MCP reply can link to /traces — same pattern
      // invoke-agent uses for its child trace.
      traceId = currentTrace()?.id ?? null;
      return runResponderLoop({
        ownerId,
        agent,
        adapter,
        apiKey,
        prefs,
        logPrefix: '[mcp-sim]',
        assembled,
        // Context was loaded before the trace opened; the core's load_context
        // step just records the snapshot for /debug/context.
        loadContext: async () => ctx,
        buildMessages: (c) =>
          buildChatMessages({
            model: agent.model,
            provider: agent.provider,
            systemPrompt: assembled.effectiveSystemPrompt,
            volatileContext: assembled.volatileContext,
            personaNotes: c.personaNotes,
            facts: c.facts,
            digests: c.digests,
            corpusMap: c.corpusMap,
            contentHits: c.contentHits,
            chunkHits: c.chunkHits,
            relations: c.relations,
            // Caller-held history — NOT c.history (the store window).
            history,
            newUserText: message,
          }),
        surface: { kind: 'web' },
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
    },
  );

  return {
    reply: outcome.reply,
    agent: { slug: agent.slug, model: agent.model },
    toolCalls: outcome.loop.toolCalls as SimToolCall[],
    toolStats: outcome.toolStats,
    pendingIds: outcome.loop.pendingIds,
    traceId,
    emptyReplySubstituted: outcome.emptyReplySubstituted,
  };
}
