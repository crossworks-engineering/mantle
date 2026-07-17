/**
 * Team Chat turn execution — one conversational turn for an EXTERNAL team
 * member (a contact holding a team token) against the permission-limited
 * `team-responder` agent.
 *
 * Deliberately a SIBLING of runAssistantTurn, not a flag on it: the owner path
 * carries a pile of owner-personal machinery (identity/journal injection,
 * heartbeats, device location, per-user thinking budgets, image retry,
 * persisted thought trails) that must never run for an outsider. This path is
 * the minimal, auditable subset:
 *
 *   1. Resolve the `team-responder` agent (explicit slug — never the persona).
 *   2. loadConversationContext for RETRIEVAL ONLY — the agent has no
 *      assistant_messages rows so its history is structurally empty; digests
 *      are off via the agent's memoryConfig (digest_limit 0); journal/identity
 *      injection is skipped entirely. History comes from the member's OWN
 *      team_messages thread and nothing else.
 *   3. Persist inbound + pending outbound to team_messages (durable steps).
 *   4. Tool loop under a 'responder_turn' trace with subject_kind 'team_turn'
 *      and surface {kind:'team', contactId} — which is how team_request_create
 *      gets forgery-proof provenance and owner-side tools refuse.
 *   5. Finalize the outbound row with the reply + the trace id (the admin's
 *      deep link from a reply to what the brain actually did).
 *
 * Isolation invariants (tested in run-team-turn.test.ts):
 *   - No persona notes, no digests, no owner conversation history in the
 *     prompt. The ONLY cross-member state is brain content retrieval.
 *   - The member's identity line rides the volatile block, so the cached
 *     system prefix stays shared across members.
 */

import { and, eq } from 'drizzle-orm';
import {
  db,
  agents,
  type Agent,
  type ConversationAttachment,
  type TeamChannel,
  type TeamMessage,
} from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import {
  buildChatMessages,
  loadConversationContext,
  type HistoryTurn,
} from '@mantle/agent-runtime';
import { getChatAdapter, stripAudioTags } from '@mantle/voice';
import {
  appendTeamMessage,
  updateTeamMessageOutcome,
  recentTeamMessages,
  loadProfilePreferences,
  isTeamPrivateReadsEnabled,
  TEAM_PRIVATE_READ_SLUGS,
} from '@mantle/content';
import { assembleResponderTurn } from './assemble-turn';
import { emptyLoopResult, runResponderLoop, type ResponderLoopResult } from './responder-loop';
import {
  startTrace,
  runDurableStep,
  emitTurnLifecycle,
  registerTurnAbort,
  unregisterTurnAbort,
  currentTrace,
} from '@mantle/tracing';

/** The one agent that serves the team surface. Provisioned by the manifest;
 *  resolved explicitly — priority/default selection never applies here. */
export const TEAM_RESPONDER_SLUG = 'team-responder';

export type RunTeamTurnOptions = {
  /** The team member this turn belongs to (from the authenticated surface). */
  contactId: string;
  /** Display name for the member-identity context line + request provenance. */
  contactName?: string;
  /** What the member typed (their bubble). Defaults to `text` — they differ
   *  when the route folded attachment markers into the LLM text. */
  displayText?: string;
  /** Attachment provenance persisted on the inbound row (files are already
   *  saved as nodes by the route's upload step). */
  attachments?: ConversationAttachment[];
  /** Transport: 'web' (the /team page), 'api' (bearer client), 'msteams'. */
  channel?: TeamChannel;
  /** Client-minted correlation id for live streaming (same contract as the
   *  owner surface — see docs/live-turn-streaming.md). */
  streamId?: string;
};

export type TeamTurnResult = {
  inbound: TeamMessage;
  outbound: TeamMessage;
  reply: string;
};

async function resolveTeamResponder(ownerId: string): Promise<Agent | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.slug, TEAM_RESPONDER_SLUG),
        eq(agents.enabled, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Map a team thread window into prompt history. Pending/failed rows and the
 *  empty pending bubble never reach the prompt. Exported for the isolation
 *  tests. */
export function teamThreadToHistory(rows: TeamMessage[]): HistoryTurn[] {
  return rows
    .filter((r) => r.status === 'complete' && r.text.trim().length > 0)
    .map((r) => ({
      role: r.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
      text: r.text,
    }));
}

export async function runTeamTurn(
  ownerId: string,
  text: string,
  options: RunTeamTurnOptions,
): Promise<TeamTurnResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('runTeamTurn: empty text');
  const { contactId } = options;
  if (!contactId) throw new Error('runTeamTurn: contactId required');
  const displayText = options.displayText?.trim() || trimmed;
  const channel: TeamChannel = options.channel ?? 'web';

  const agent = await resolveTeamResponder(ownerId);
  if (!agent) {
    throw new Error(
      "Team Chat isn't provisioned on this brain — the 'team-responder' agent is missing or disabled.",
    );
  }
  if (!agent.apiKeyId) {
    throw new Error(`Agent '${agent.slug}' has no api_key_id set — edit at /settings/agents.`);
  }
  const apiKey = await getApiKeyById(agent.apiKeyId);
  if (!apiKey) {
    throw new Error(`api_key_id ${agent.apiKeyId} not found for agent '${agent.slug}'.`);
  }

  // Retrieval context. The team-responder has no assistant_messages rows, so
  // ctx.history is structurally empty; digests are off via the agent's
  // memoryConfig. We use facts/contentHits/chunkHits/relations only, and load
  // the REAL history from the member's own team thread below.
  const ctx = await loadConversationContext({ ownerId, agent, inboundText: trimmed });
  const memoryConfig = (agent.memoryConfig ?? {}) as { history_limit?: number };
  const teamHistoryRows = await recentTeamMessages(
    ownerId,
    contactId,
    memoryConfig.history_limit ?? 20,
  );
  const history = teamThreadToHistory(teamHistoryRows);

  const inbound = await runDurableStep('record_team_inbound', () =>
    appendTeamMessage({
      ownerId,
      contactId,
      direction: 'inbound',
      text: displayText,
      channel,
      attachments: options.attachments ?? [],
    }),
  );

  // Durable "thinking…" bubble — same contract as the owner surface, so the
  // member UI + a reload mid-turn can bind to a stable outbound id. History
  // loading filters status='complete', so this empty row never reaches a
  // later turn's prompt.
  const outboundPending = await runDurableStep('record_team_outbound_pending', () =>
    appendTeamMessage({
      ownerId,
      contactId,
      direction: 'outbound',
      text: '',
      channel,
      agentId: agent.id,
      model: agent.model,
      status: 'pending',
    }),
  );

  if (options.streamId) {
    emitTurnLifecycle(options.streamId, ownerId, 'turn-start', {
      agentSlug: agent.slug,
      model: agent.model,
      inboundId: inbound.id,
      outboundId: outboundPending.id,
    });
  }
  const abortController = options.streamId ? registerTurnAbort(options.streamId, ownerId) : null;
  const retireAbort = () => {
    if (options.streamId) unregisterTurnAbort(options.streamId);
  };

  const prefs = await loadProfilePreferences(ownerId);
  // Member identity rides the VOLATILE block: per-contact text in the cached
  // prefix would bust the shared per-agent cache on every member switch.
  const memberLine = `Team member: ${options.contactName ?? 'unknown name'} (contact ${contactId}). You are serving this person — an external team member, not the brain's owner.`;

  // Shared responder-turn assembly (audit #5c), configured for the team
  // surface's HARD isolation: no identity/journal block, no heartbeats, no
  // owner thinking budget, no delegation (fail closed). The private-reads
  // switch (default OFF) is enforced HERE, at tool resolution — independent
  // of the `team-read` group grant, so it can't be bypassed by a manifest
  // change that re-adds the slugs.
  const assembled = await assembleResponderTurn({
    ownerId,
    agent,
    prefs,
    logPrefix: '[team-turn]',
    includeIdentity: false,
    volatileExtras: [memberLine],
    withThinking: false,
    allowDelegation: false,
    excludeToolSlugs: isTeamPrivateReadsEnabled(prefs) ? [] : TEAM_PRIVATE_READ_SLUGS,
  });
  const { volatileContext, allowedTools } = assembled;

  const adapter = getChatAdapter(agent.provider);
  if (!adapter) {
    throw new Error(
      `team turn: no chat adapter for provider '${agent.provider}' (agent ${agent.slug})`,
    );
  }

  const messages = buildChatMessages({
    model: agent.model,
    provider: agent.provider,
    systemPrompt: assembled.effectiveSystemPrompt,
    volatileContext,
    // HARD isolation: no persona notes, no digests — owner-personal context
    // never reaches a team turn (see header invariants).
    personaNotes: [],
    facts: ctx.facts,
    digests: [],
    contentHits: ctx.contentHits,
    chunkHits: ctx.chunkHits,
    relations: ctx.relations,
    history,
    newUserText: trimmed,
  });

  let capturedTraceId: string | null = null;
  let outcome: ResponderLoopResult;
  try {
    outcome = await startTrace(
      {
        kind: 'responder_turn',
        ownerId,
        turnId: options.streamId,
        subjectId: inbound.id,
        subjectKind: 'team_turn',
        agentId: agent.id,
        data: {
          surface: 'team',
          contact_id: contactId,
          channel,
          model: agent.model,
          agent_slug: agent.slug,
          tool_count: allowedTools.length,
        },
      },
      async () => {
        capturedTraceId = currentTrace()?.id ?? null;
        return runResponderLoop({
          ownerId,
          agent,
          adapter,
          apiKey,
          prefs,
          logPrefix: '[team-turn]',
          // Fail closed: the team responder never delegates (assembly ran
          // with allowDelegation:false / withThinking:false). `assembled` also
          // carries loopOverrides (spread by runResponderLoop): since the
          // unification, the team-responder's memory_config max_tool_calls /
          // max_calls_per_tool clamps are enforced here where they weren't
          // before — safe (tighter caps), inert unless the agent configures them.
          assembled,
          // Retrieval ran before the trace; the member's REAL history came
          // from their own team thread, so the step's turnCount reflects
          // that thread, not the structurally-empty ctx history.
          loadContext: async () => ctx,
          contextStepInput: { agentId: agent.id, contactId },
          contextStepExtra: { turnCount: history.length },
          buildMessages: () => messages,
          // The provenance channel: team_request_create reads WHO is asking
          // from here; owner-side tools see 'team' and refuse.
          surface: {
            kind: 'team',
            contactId,
            contactName: options.contactName,
            inboundMessageId: inbound.id,
          },
          abortSignal: abortController?.signal ?? null,
        });
      },
    );
  } catch (err) {
    if (abortController?.signal.aborted) {
      outcome = {
        loop: emptyLoopResult(),
        reply: '',
        emptyReplySubstituted: false,
        persistedThoughts: [],
        toolStats: null,
        ctx,
      };
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      await runDurableStep('fail_team_outbound', () =>
        updateTeamMessageOutcome({
          ownerId,
          id: outboundPending.id,
          status: 'failed',
          error: msg,
          traceId: capturedTraceId,
        }),
      ).catch((e) => console.error('[team-turn] could not mark turn failed:', e));
      if (options.streamId) emitTurnLifecycle(options.streamId, ownerId, 'error', { message: msg });
      retireAbort();
      throw err;
    }
  }

  // The core already applied the shared empty-reply fallback (a Stop keeps
  // its partial reply). Strip audio tags — the team surface is text-only.
  const reply = stripAudioTags(outcome.reply).text;

  const finalized = await runDurableStep('finalize_team_outbound', () =>
    updateTeamMessageOutcome({
      ownerId,
      id: outboundPending.id,
      status: 'complete',
      text: reply,
      model: agent.model,
      traceId: capturedTraceId,
    }),
  );
  const outbound: TeamMessage = finalized ?? {
    ...outboundPending,
    text: reply,
    status: 'complete',
    traceId: capturedTraceId,
  };

  retireAbort();
  if (options.streamId) {
    emitTurnLifecycle(options.streamId, ownerId, 'done', {
      outboundId: outboundPending.id,
      tokensOut: outcome.loop.tokensOut,
    });
  }

  return { inbound, outbound, reply };
}
