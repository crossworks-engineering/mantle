/**
 * Member chat turn execution: one conversational turn for a MEMBER LOGIN
 * against the permission-limited `team-responder` agent (member logins; the
 * team-code portal contact path this once also served was retired in Phase 6).
 * The member chat route (POST /api/member/chat) enqueues it.
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
 *      team_messages thread (by login) and nothing else.
 *   3. Persist inbound + pending outbound to team_messages (durable steps).
 *   4. Tool loop under a 'responder_turn' trace with subject_kind 'team_turn'
 *      and surface {kind:'team', loginId}, which is how team_request_create
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
  withViewer,
  type ViewerLevel,
  type Agent,
  type ConversationAttachment,
  type TeamChannel,
  type TeamMessage,
} from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import {
  buildChatMessages,
  loadConversationContext,
  type ConversationContext,
  type HistoryTurn,
} from '../agent';
import { getChatAdapter, stripAudioTags } from '@mantle/voice';
import {
  appendTeamMessage,
  updateTeamMessageOutcome,
  recentTeamMessages,
  loadProfilePreferences,
  isTeamPrivateReadsEnabled,
  teamHiddenNodeTypes,
  TEAM_PRIVATE_READ_SLUGS,
  clientTurnMayRun,
} from '@mantle/content';
import type { ContextSnapshot } from '@mantle/client-types';
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
import { CLIENT_TURN_TOOL_SLUGS, PRIVATE_OUTPUT_TOOL_SLUGS } from '@mantle/tools';
import { agentLevel, withAgentViewer } from '../agent/agent-viewer';

/** The one agent that serves the team surface. Provisioned by the manifest;
 *  resolved explicitly — priority/default selection never applies here. */
export const TEAM_RESPONDER_SLUG = 'team-responder';

/** The agent that serves a CLIENT login's chat (client logins C4). The
 *  manifest ships it at client level on every brain. */
export const CLIENT_RESPONDER_SLUG = 'client-responder';

/** Who a login turn serves: a team member or a client (client logins C4). */
export type LoginTurnRole = 'member' | 'client';

/** The ONE agent level each role chats with (plan section 8): a member with a
 *  team-level agent, a client with a client-level one. */
const ROLE_AGENT_LEVEL: Record<LoginTurnRole, ViewerLevel> = { member: 'team', client: 'client' };
const ROLE_DEFAULT_AGENT: Record<LoginTurnRole, string> = {
  member: TEAM_RESPONDER_SLUG,
  client: CLIENT_RESPONDER_SLUG,
};

export type RunTeamTurnOptions = {
  /** Display name for the member-identity context line + request provenance. */
  contactName?: string;
  /** What the member typed (their bubble). Defaults to `text` — they differ
   *  when the route folded attachment markers into the LLM text. */
  displayText?: string;
  /** Attachment provenance persisted on the inbound row (files are already
   *  saved as nodes by the route's upload step). */
  attachments?: ConversationAttachment[];
  /** Transport: 'web' (the member chat). */
  channel?: TeamChannel;
  /** Client-minted correlation id for live streaming (same contract as the
   *  owner surface — see docs/live-turn-streaming.md). */
  streamId?: string;
  /** The MEMBER login this turn belongs to (member logins, plan section 5):
   *  the turn joins that login's own thread, and the agent must be below
   *  admin (members chat only with team-level agents). Required: the
   *  team-code portal's contact turns are retired (Phase 6). */
  loginId: string;
  /** The agent to answer (default team-responder). A member turn takes a
   *  team-level agent only. */
  agentSlug?: string;
};

/** A CLIENT login's turn (client logins C4, POST /api/client/chat). */
export type RunClientTurnOptions = Omit<RunTeamTurnOptions, 'attachments'> & {
  /** The login's session epoch when the turn was queued: the turn runs only
   *  while it is still the login's epoch (sign-out everywhere, End sessions
   *  and Disable stop a queued turn). */
  sessionEpoch: number;
};

export type TeamTurnResult = {
  inbound: TeamMessage;
  outbound: TeamMessage;
  reply: string;
};

async function resolveLoginAgent(ownerId: string, slug: string): Promise<Agent | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, slug), eq(agents.enabled, true)))
    .limit(1);
  return row ?? null;
}

/**
 * A login chats with an agent at exactly its role's level (plan section 8):
 * a member with a team-level agent, a client with a client-level one. The
 * chat routes check this too; this is the engine's own refusal, so no caller
 * can hand a member an admin or client agent, or a client a team agent.
 * Exported for the tests.
 */
export function assertAgentForRole(
  agent: { slug: string; audience?: string | null },
  role: LoginTurnRole,
): void {
  const level = agentLevel(agent);
  const want = ROLE_AGENT_LEVEL[role];
  if (level !== want) {
    throw new Error(
      `Agent '${agent.slug}' is at the ${level} level: a ${role} login may only chat with a ${want}-level agent.`,
    );
  }
}

/** The client turn's tools: the assembled ones that are client tools
 *  (CLIENT_TURN_TOOL_SLUGS), the rest dropped. */
function clientToolsOnly<T extends { allowedTools: Array<{ slug: string }> }>(assembled: T): T {
  const allowed = new Set(CLIENT_TURN_TOOL_SLUGS);
  return { ...assembled, allowedTools: assembled.allowedTools.filter((t) => allowed.has(t.slug)) };
}

/** A client turn's retrieval context: none at all. Facts, summaries, chunks
 *  and the graph were built from page text that can name team and admin
 *  items (mention and link labels, plan N6), so a client turn reads only
 *  through its client tools, which serve the portal's redacted bodies.
 *  Exported for the tests. */
export function emptyLoginContext(inboundText: string): ConversationContext {
  const snapshot: ContextSnapshot = {
    query: { inbound: inboundText.slice(0, 600), enriched: null, embedded: false },
    facts: { sent: [], dropped: [], guard: 0 },
    contentHits: { sent: [], dropped: [], cutoff: 0 },
    chunkHits: { sent: [], dropped: [], cutoff: 0 },
    relations: [],
    digests: { count: 0, topics: [] },
    history: { count: 0, toolRecords: 0, mediaRecords: 0 },
    personaNotes: { count: 0 },
    corpusMap: { count: 0, truncated: false },
  };
  return {
    personaNotes: [],
    facts: [],
    corpusMap: { entries: [], truncated: false },
    contentHits: [],
    chunkHits: [],
    relations: [],
    digests: [],
    history: [],
    journalRelevant: '',
    snapshot,
  };
}

/**
 * Whether a team reply may quote the member's PRIVATE items (audit S3): the
 * turn read them with a my-space tool, or the history the model saw holds a
 * reply that did (a follow-up can repeat what the earlier reply quoted).
 */
export function replyUsedPrivate(
  toolCalls: readonly { slug: string }[],
  history: readonly { usedPrivate?: boolean | null }[],
): boolean {
  return (
    toolCalls.some((c) => PRIVATE_OUTPUT_TOOL_SLUGS.has(c.slug)) ||
    history.some((r) => r.usedPrivate === true)
  );
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

/** The loaded thread window less this turn's own inbound row (present when
 *  the turn was recovered after writing it). Exported for the tests. */
export function historyBeforeInbound<T extends { id: string }>(rows: T[], inboundId: string): T[] {
  return rows.filter((r) => r.id !== inboundId);
}

export async function runTeamTurn(
  ownerId: string,
  text: string,
  options: RunTeamTurnOptions,
): Promise<TeamTurnResult> {
  return runLoginTurn('member', ownerId, text, options);
}

/**
 * A CLIENT login's chat turn (client logins C4, plan section 8): the member
 * turn's engine with the client's limits. The agent must be at client level;
 * the whole turn ALSO runs inside withViewer('client'), so the level is the
 * lower of the agent's and the login's (N7) even if an agent were raised; no
 * retrieval context (emptyLoginContext); the client tools on a client surface;
 * and the login is re-read before anything runs (clientTurnMayRun).
 */
export async function runClientTurn(
  ownerId: string,
  text: string,
  options: RunClientTurnOptions,
): Promise<TeamTurnResult> {
  return runLoginTurn('client', ownerId, text, options);
}

async function runLoginTurn(
  role: LoginTurnRole,
  ownerId: string,
  text: string,
  options: RunTeamTurnOptions & { sessionEpoch?: number },
): Promise<TeamTurnResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('runTeamTurn: empty text');
  // A client turn queued before a sign-out everywhere, End sessions or
  // Disable never runs: nothing is written and no model is called.
  if (role === 'client') {
    const epoch = options.sessionEpoch;
    if (typeof epoch !== 'number' || !(await clientTurnMayRun(options.loginId, epoch))) {
      throw new Error('client turn dropped: the client login is no longer signed in');
    }
  }
  // A turn input from before Phase 6 may still name only a portal contact
  // (a workflow recovered on upgrade): refuse it, as the portal is gone.
  if (!options.loginId) {
    throw new Error('runTeamTurn: loginId required (the team-code portal chat is retired)');
  }
  const displayText = options.displayText?.trim() || trimmed;
  const channel: TeamChannel = options.channel ?? 'web';
  const progress = { inboundWritten: false };
  try {
    const steps = () =>
      runTeamTurnSteps(role, ownerId, trimmed, displayText, channel, options, progress);
    // The client's own wrap (N7): the turn never reads above client level,
    // whatever the agent's level says.
    return await (role === 'client' ? withViewer('client', steps) : steps());
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
          contactId: null,
          direction: 'inbound',
          text: displayText,
          channel,
          attachments: options.attachments ?? [],
          loginId: options.loginId,
        });
        await appendTeamMessage({
          ownerId,
          contactId: null,
          direction: 'outbound',
          text: '',
          channel,
          error: errorMessage(err),
          loginId: options.loginId,
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
  role: LoginTurnRole,
  ownerId: string,
  trimmed: string,
  displayText: string,
  channel: TeamChannel,
  options: RunTeamTurnOptions,
  progress: { inboundWritten: boolean },
): Promise<TeamTurnResult> {
  const { loginId } = options;
  const agentSlug = options.agentSlug ?? ROLE_DEFAULT_AGENT[role];
  const agent = await resolveLoginAgent(ownerId, agentSlug);
  if (!agent) {
    throw new Error(
      `${role === 'client' ? 'Client' : 'Team'} chat isn't provisioned on this brain: the '${agentSlug}' agent is missing or disabled.`,
    );
  }
  assertAgentForRole(agent, role);
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
    // The owner's private-reads switch is for team turns only.
    const privateReads = role === 'member' && isTeamPrivateReadsEnabled(prefs);
    const ctx =
      role === 'client'
        ? emptyLoginContext(trimmed)
        : await withTracePrelude(prelude, () =>
            loadConversationContext({
              ownerId,
              agent,
              inboundText: trimmed,
              includeJournal: false,
              excludeNodeTypes: teamHiddenNodeTypes(privateReads),
            }),
          );
    const memoryConfig = (agent.memoryConfig ?? {}) as { history_limit?: number };
    const loadedHistoryRows = await recentTeamMessages(
      ownerId,
      '', // a login's thread is read by login
      memoryConfig.history_limit ?? 20,
      loginId,
    );

    const inbound = await runDurableStep('record_team_inbound', () =>
      appendTeamMessage({
        ownerId,
        contactId: null,
        direction: 'inbound',
        text: displayText,
        channel,
        attachments: options.attachments ?? [],
        loginId,
      }),
    );
    progress.inboundWritten = true;
    // The history is read before the inbound step, outside any durable step,
    // so a turn RECOVERED after that step (DBOS replays it from the journal)
    // finds its own inbound row already in the thread: it would reach the
    // model twice, once as history and once as the new message (audit F31).
    const teamHistoryRows = historyBeforeInbound(loadedHistoryRows, inbound.id);
    const history = teamThreadToHistory(teamHistoryRows);

    // Durable "thinking…" bubble — same contract as the owner surface, so the
    // member UI + a reload mid-turn can bind to a stable outbound id. History
    // loading filters status='complete', so this empty row never reaches a
    // later turn's prompt.
    const outboundPending = await runDurableStep('record_team_outbound_pending', () =>
      appendTeamMessage({
        ownerId,
        contactId: null,
        direction: 'outbound',
        text: '',
        channel,
        agentId: agent.id,
        model: agent.model,
        status: 'pending',
        loginId,
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
    const memberLine =
      role === 'client'
        ? `Client: ${options.contactName ?? 'unknown name'} (client login ${loginId}). You are serving this person: a client of the team, not a team member and not the brain's owner.`
        : `Team member: ${options.contactName ?? 'unknown name'} (user ${loginId}). You are serving this person: a member of the team, not the brain's owner.`;

    // Shared responder-turn assembly (audit #5c), configured for the team
    // surface's HARD isolation: no identity/journal block, no heartbeats, no
    // owner thinking budget, no delegation (fail closed). The private-reads
    // switch (default OFF) is enforced HERE, at tool resolution — independent
    // of the `team-read` group grant, so it can't be bypassed by a manifest
    // change that re-adds the slugs.
    const assembledForAgent = await withTracePrelude(prelude, () =>
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
    // A client turn gets the client tools and nothing else, whatever the
    // agent's groups hold (client logins C5 audit, L3): a group is config,
    // and a brain-wide read tool at client level still shows what the portal
    // never does. Applied last, to everything the assembly offers.
    const assembled = role === 'client' ? clientToolsOnly(assembledForAgent) : assembledForAgent;
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
            surface: role === 'client' ? 'client' : 'team',
            login_role: role,
            contact_id: null,
            login_id: loginId,
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
            contextStepInput: { agentId: agent.id, contactId: null, loginId },
            contextStepExtra: { turnCount: history.length },
            buildMessages: () => messages,
            // The provenance channel: team_request_create reads WHO is asking
            // from here; owner-side tools see 'team' and refuse.
            surface:
              role === 'client'
                ? {
                    kind: 'client',
                    loginId,
                    contactName: options.contactName,
                    inboundMessageId: inbound.id,
                  }
                : {
                    kind: 'team',
                    loginId,
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
    // Node reference only, never the base64. A route that serves the bytes to
    // the member must authorize off this very column (the retired team-code
    // chat did), so an artifact WITHOUT a node id has nothing to point at and
    // is dropped rather than written as an unreachable row.
    //
    // A reply can also PLACE a picture itself with `![alt](media:<id>)`. Anything
    // it placed must not ALSO appear in the strip below; artifactsNotPlacedInline
    // is the shared rule (inline-images.ts).
    const durableAttachments = durableAttachmentsFor(outcome.loop.artifacts, reply);

    // Admins never see a member's private items (audit S3): a reply that read
    // them with a my-space tool, or that follows such a reply in the history
    // the model saw, is marked; the admin readers show a placeholder.
    const usedPrivate = replyUsedPrivate(outcome.loop.toolCalls, teamHistoryRows);
    const finalized = await runDurableStep('finalize_team_outbound', () =>
      updateTeamMessageOutcome({
        ownerId,
        id: outboundPending.id,
        status: 'complete',
        text: reply,
        model: agent.model,
        traceId: capturedTraceId,
        usedPrivate,
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
