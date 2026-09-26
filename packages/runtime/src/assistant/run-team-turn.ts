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
import { buildChatMessages, loadConversationContext, type HistoryTurn } from '../agent';
import { getChatAdapter, stripAudioTags } from '@mantle/voice';
import {
  appendTeamMessage,
  updateTeamMessageOutcome,
  recentTeamMessages,
  loadProfilePreferences,
  isTeamPrivateReadsEnabled,
  teamHiddenNodeTypes,
  TEAM_PRIVATE_READ_SLUGS,
} from '@mantle/content';
import { assembleResponderTurn } from './assemble-turn';
import { durableAttachmentsFor } from './inline-images';
import { emptyLoopResult, runResponderLoop, type ResponderLoopResult } from './responder-loop';
import {
  startTrace,
  runDurableStep,
  emitTurnLifecycle,
  registerTurnAbort,
  unregisterTurnAbort,
  currentTrace,
  createTracePrelude,
  withTracePrelude,
} from '@mantle/tracing';
import { errorMessage } from '@mantle/std';
import { agentLevel, withAgentViewer } from '../agent/agent-viewer';

/** The one agent that serves the team surface. Provisioned by the manifest;
 *  resolved explicitly — priority/default selection never applies here. */
export const TEAM_RESPONDER_SLUG = 'team-responder';

export type RunTeamTurnOptions = {
  /** The team portal contact this turn belongs to (from the authenticated
   *  surface). Absent for a member LOGIN's turn: users are the team (0167),
   *  so `loginId` identifies the member instead. One of the two is required. */
  contactId?: string;
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
  /** A MEMBER login's turn (member logins, plan section 5): the turn joins
   *  that login's own thread, and the agent must be below admin (members
   *  chat only with team-level agents). */
  loginId?: string;
  /** The agent to answer (default team-responder). A member turn refuses an
   *  admin-level agent. */
  agentSlug?: string;
};

export type TeamTurnResult = {
  inbound: TeamMessage;
  outbound: TeamMessage;
  reply: string;
};

async function resolveTeamResponder(
  ownerId: string,
  slug: string = TEAM_RESPONDER_SLUG,
): Promise<Agent | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, slug), eq(agents.enabled, true)))
    .limit(1);
  return row ?? null;
}

/**
 * Members chat only with team-level agents (plan section 5). The member route
 * checks this too; this is the engine's own refusal, so no caller can hand a
 * member login an admin agent. Exported for the tests.
 */
export function assertMemberAgent(
  agent: { slug: string; audience?: string | null },
  loginId: string | undefined,
): void {
  if (loginId && agentLevel(agent) === 'admin') {
    throw new Error(
      `Agent '${agent.slug}' is at the admin level: a member login may only chat with a team-level agent.`,
    );
  }
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
  const contactId = options.contactId ?? null;
  if (!contactId && !options.loginId) throw new Error('runTeamTurn: contactId or loginId required');
  const displayText = options.displayText?.trim() || trimmed;
  const channel: TeamChannel = options.channel ?? 'web';
  const progress = { inboundWritten: false };
  try {
    return await runTeamTurnSteps(ownerId, trimmed, displayText, channel, options, progress);
  } catch (err) {
    // A turn that fails BEFORE the inbound row is written (no agent, no key,
    // retrieval down) used to leave nothing behind: the route had already
    // answered 202, so the message simply vanished (audit MED 12). Record it
    // with a failed reply, so the thread shows the message and "did not go
    // through". Failures after that point mark their own pending row.
    if (!progress.inboundWritten) {
      await runDurableStep('record_team_failed_early', async () => {
        await appendTeamMessage({
          ownerId,
          contactId,
          direction: 'inbound',
          text: displayText,
          channel,
          attachments: options.attachments ?? [],
          loginId: options.loginId ?? null,
        });
        await appendTeamMessage({
          ownerId,
          contactId,
          direction: 'outbound',
          text: '',
          channel,
          error: errorMessage(err),
          loginId: options.loginId ?? null,
        });
      }).catch((e) => console.error('[team-turn] could not record the failed turn:', e));
      if (options.streamId) {
        emitTurnLifecycle(options.streamId, ownerId, 'error', { message: errorMessage(err) });
      }
    }
    throw err;
  }
}

async function runTeamTurnSteps(
  ownerId: string,
  trimmed: string,
  displayText: string,
  channel: TeamChannel,
  options: RunTeamTurnOptions,
  progress: { inboundWritten: boolean },
): Promise<TeamTurnResult> {
  const contactId = options.contactId ?? null;

  const { loginId } = options;
  const agent = await resolveTeamResponder(ownerId, options.agentSlug);
  if (!agent) {
    throw new Error(
      `Team Chat isn't provisioned on this brain — the '${options.agentSlug ?? TEAM_RESPONDER_SLUG}' agent is missing or disabled.`,
    );
  }
  assertMemberAgent(agent, loginId);
  if (!agent.apiKeyId) {
    throw new Error(`Agent '${agent.slug}' has no api_key_id set — edit at /settings/agents.`);
  }
  const apiKey = await getApiKeyById(agent.apiKeyId);
  if (!apiKey) {
    throw new Error(`api_key_id ${agent.apiKeyId} not found for agent '${agent.slug}'.`);
  }

  // Everything below runs at the agent's level (agents.audience): a team
  // responder reads only what row level security shows the team role.
  return withAgentViewer(agent, async () => {
    // Retrieval context. The team-responder has no assistant_messages rows, so
    // ctx.history is structurally empty; digests are off via the agent's
    // memoryConfig. We use facts/contentHits/chunkHits/relations only, and load
    // the REAL history from the member's own team thread below.
    // Steps before the trace opens (the decider's pruning + hint calls, the
    // query embed) are held here and written into the trace below.
    const prelude = createTracePrelude();
    // The owner's private-reads switch is read BEFORE retrieval: the context
    // loader hides the same node types the read tools do.
    const prefs = await loadProfilePreferences(ownerId);
    const privateReads = isTeamPrivateReadsEnabled(prefs);
    const ctx = await withTracePrelude(prelude, () =>
      loadConversationContext({
        ownerId,
        agent,
        inboundText: trimmed,
        includeJournal: false,
        excludeNodeTypes: teamHiddenNodeTypes(privateReads),
      }),
    );
    const memoryConfig = (agent.memoryConfig ?? {}) as { history_limit?: number };
    const teamHistoryRows = await recentTeamMessages(
      ownerId,
      contactId ?? '', // a login's thread is read by login
      memoryConfig.history_limit ?? 20,
      loginId,
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
        loginId: loginId ?? null,
      }),
    );
    progress.inboundWritten = true;

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
        loginId: loginId ?? null,
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

    // Member identity rides the VOLATILE block: per-contact text in the cached
    // prefix would bust the shared per-agent cache on every member switch.
    const who = loginId ? `user ${loginId}` : `contact ${contactId}`;
    const memberLine = `Team member: ${options.contactName ?? 'unknown name'} (${who}). You are serving this person — an external team member, not the brain's owner.`;

    // Shared responder-turn assembly (audit #5c), configured for the team
    // surface's HARD isolation: no identity/journal block, no heartbeats, no
    // owner thinking budget, no delegation (fail closed). The private-reads
    // switch (default OFF) is enforced HERE, at tool resolution — independent
    // of the `team-read` group grant, so it can't be bypassed by a manifest
    // change that re-adds the slugs.
    const assembled = await withTracePrelude(prelude, () =>
      assembleResponderTurn({
        ownerId,
        agent,
        prefs,
        logPrefix: '[team-turn]',
        includeIdentity: false,
        volatileExtras: [memberLine],
        withThinking: false,
        allowDelegation: false,
        excludeToolSlugs: privateReads ? [] : TEAM_PRIVATE_READ_SLUGS,
      }),
    );
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
          prelude,
          ownerId,
          turnId: options.streamId,
          subjectId: inbound.id,
          subjectKind: 'team_turn',
          agentId: agent.id,
          data: {
            surface: 'team',
            contact_id: contactId,
            ...(loginId ? { login_id: loginId } : {}),
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
            contextStepInput: { agentId: agent.id, contactId, loginId: loginId ?? null },
            contextStepExtra: { turnCount: history.length },
            buildMessages: () => messages,
            // The provenance channel: team_request_create reads WHO is asking
            // from here; owner-side tools see 'team' and refuse.
            surface: {
              kind: 'team',
              ...(contactId ? { contactId } : {}),
              ...(loginId ? { loginId } : {}),
              contactName: options.contactName,
              privateReads,
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
          blockedByProvider: false,
          truncated: false,
          persistedThoughts: [],
          toolStats: null,
          ctx,
        };
      } else {
        const msg = errorMessage(err);
        await runDurableStep('fail_team_outbound', () =>
          updateTeamMessageOutcome({
            ownerId,
            id: outboundPending.id,
            status: 'failed',
            error: msg,
            traceId: capturedTraceId,
          }),
        ).catch((e) => console.error('[team-turn] could not mark turn failed:', e));
        if (options.streamId)
          emitTurnLifecycle(options.streamId, ownerId, 'error', { message: msg });
        retireAbort();
        throw err;
      }
    }

    // The core already applied the shared empty-reply fallback (a Stop keeps
    // its partial reply). Strip audio tags — the team surface is text-only.
    const reply = stripAudioTags(outcome.reply).text;

    // Persist the turn's media onto the row — the same rule the owner turn
    // follows (run-turn.ts), and for the same reason: the live `artifacts`
    // channel only reaches a client on the legacy blocking response, so an
    // artifact not written here is never rendered at all.
    //
    // Node reference only, never the base64. A member loads the bytes through
    // `/api/team/messages/media/<nodeId>`, which authorizes off this
    // very column — so an artifact WITHOUT a node id has nothing to point at and
    // is dropped rather than written as an unreachable row.
    //
    // A reply can also PLACE a picture itself with `![alt](media:<id>)`. Anything
    // it placed must not ALSO appear in the strip below; artifactsNotPlacedInline
    // is the shared rule (inline-images.ts).
    const durableAttachments = durableAttachmentsFor(outcome.loop.artifacts, reply);

    const finalized = await runDurableStep('finalize_team_outbound', () =>
      updateTeamMessageOutcome({
        ownerId,
        id: outboundPending.id,
        status: 'complete',
        text: reply,
        model: agent.model,
        traceId: capturedTraceId,
        ...(durableAttachments.length ? { attachments: durableAttachments } : {}),
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
  });
}
