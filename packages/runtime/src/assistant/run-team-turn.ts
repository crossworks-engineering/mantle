/**
 * Workspace chat turn execution: one conversational turn for a LOGIN against
 * the assistant of a workspace other than Admin (any workspace the login is a
 * user of since W7c; with none named, its default, defaultWorkspaceAssistant:
 * its oldest workspace beyond Admin with an assistant). POST
 * /api/assistant/turn enqueues it for such an assistant (the member chat
 * route it served before answers 410 since W7c).
 *
 * Deliberately a SIBLING of runAssistantTurn, not a flag on it: the owner path
 * carries a pile of owner-personal machinery (identity/journal injection,
 * heartbeats, device location, per-user thinking budgets, image retry,
 * persisted thought trails) that must never run for an outsider. This path is
 * the minimal, auditable subset:
 *
 *   1. Resolve the workspace's assistant (a workspace resource, never an
 *      agent level and never the persona).
 *   2. loadConversationContext for retrieval and the login's own digests
 *      (per agent and login, 0269; the shipped Team assistant has them off,
 *      digest_limit 0); journal/identity injection is skipped entirely.
 *      History comes from the login's OWN thread with this assistant
 *      (assistant_messages by agent and login, inside the open chat thread)
 *      and nothing else.
 *   3. Persist inbound + pending outbound to that thread (durable steps).
 *   4. Tool loop under a 'responder_turn' trace with subject_kind 'team_turn'
 *      and surface {kind:'team', loginId}, which is how team_request_create
 *      gets forgery-proof provenance and owner-side tools refuse.
 *   5. Finalize the outbound row with the reply + the trace id (the admin's
 *      deep link from a reply to what the brain actually did).
 *
 * Isolation invariants (tested in run-team-turn.test.ts):
 *   - No persona notes, no owner conversation history, no other login's
 *     turns or digests in the prompt. The ONLY cross-member state is brain
 *     content retrieval.
 *   - A delegation (Draftsman, Presenter, Appsmith only: the workspace
 *     delegates) runs its child in this turn's scope and on its surface:
 *     this login's rights in this workspace, none of the owner's context;
 *     its tokens count on the turn's ledger slot.
 *   - The member's identity line rides the volatile block, so the cached
 *     system prefix stays shared across members.
 */

import { and, eq } from 'drizzle-orm';
import {
  db,
  agents,
  authUsers,
  openChatThread,
  type Agent,
  type ConversationAttachment,
} from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { isLoginRole } from '@mantle/client-types/role-names';
import {
  buildChatMessages,
  loadConversationContext,
  type ConversationContext,
  type HistoryTurn,
} from '../agent';
import { getChatAdapter, stripAudioTags } from '@mantle/voice';
import {
  appendThreadMessage,
  updateThreadMessageOutcome,
  recentThreadMessages,
  loadProfilePreferences,
  isTeamPrivateReadsEnabled,
  teamHiddenNodeTypes,
  defaultWorkspaceAssistant,
  workspaceAssistantFor,
  type ThreadMessage,
  settleMemberTurn,
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
  log,
} from '@mantle/tracing';
import { personProviderErrorMessage } from '@mantle/std';
import { PRIVATE_OUTPUT_TOOL_SLUGS } from '@mantle/tools';
import { withAgentViewer } from '../agent/agent-viewer';

/** Transport a team turn arrived on: 'web' (the app), 'api' (a bearer
 *  client), 'msteams' (an 'api' client that tags itself). Its own type
 *  since team_messages, which declared it, was dropped (0274, W8d). */
type TeamChannel = 'web' | 'api' | 'msteams';

// The responder slugs live in a leaf module (slugs.ts), so a data module
// reads them without this runtime; named here as before.
export { CLIENT_RESPONDER_SLUG, TEAM_RESPONDER_SLUG } from '../slugs';

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
   *  the turn joins that login's own thread, and runs in the scope of the
   *  assistant's workspace for that login. Required: the team-code portal's
   *  contact turns are retired (Phase 6). */
  loginId: string;
  /** The agent the route resolved (an assistant of a workspace of the
   *  login). The turn re-checks it: an agent that is not such an assistant
   *  now is refused. Absent: the login's default
   *  (defaultWorkspaceAssistant). */
  agentSlug?: string;
  /** The turn's slot in the member turn ledger (its workflow id), when the
   *  enqueue claimed one (a login that is not an Admin user): the turn's
   *  model tokens are stamped on it at the trace's close (settleMemberTurn,
   *  0327), and the token budget sums them. */
  ledgerTurnId?: string;
};

/** A CLIENT login's turn (client logins C4). Client chat went in W5c: the
 *  type stays only so a queued turn's input still parses. */
export type RunClientTurnOptions = Omit<RunTeamTurnOptions, 'attachments'> & {
  /** The login's session epoch when the turn was queued: the turn runs only
   *  while it is still the login's epoch (sign-out everywhere, End sessions
   *  and Disable stop a queued turn). */
  sessionEpoch: number;
};

export type TeamTurnResult = {
  inbound: ThreadMessage;
  outbound: ThreadMessage;
  reply: string;
};

async function resolveAgentById(ownerId: string, id: string): Promise<Agent | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.id, id), eq(agents.enabled, true)))
    .limit(1);
  return row ?? null;
}

/**
 * The agent a workspace turn runs: the assistant a workspace holds, never one
 * picked by level (workspaces W5c). With a slug, it must be the assistant of
 * a workspace other than Admin that the login is a user of (W7c); without
 * one, the login's default (defaultWorkspaceAssistant). The route resolves it too; this is the engine's
 * own check, so no caller can hand a login another agent. The Admin
 * assistant never runs here (the owner turn engine runs it).
 */
async function resolveMemberAgent(
  ownerId: string,
  slug: string | undefined,
  loginId: string,
): Promise<Agent> {
  const team = slug
    ? await workspaceAssistantFor(ownerId, loginId, slug)
    : await defaultWorkspaceAssistant(ownerId, loginId);
  if (!team) {
    throw new Error(
      slug
        ? `Agent '${slug}' is not the assistant of a workspace this login is a user of.`
        : 'This login is in no workspace other than Admin with an enabled assistant.',
    );
  }
  if (team.isAdmin) {
    throw new Error(
      `Agent '${team.slug}' is the Admin assistant: it does not run as a workspace turn.`,
    );
  }
  const agent = await resolveAgentById(ownerId, team.id);
  if (!agent) {
    throw new Error(`Agent '${team.slug}' is not an enabled assistant of this brain.`);
  }
  // The turn scope comes from the agent's own workspace (withAgentViewer):
  // it must be the workspace that holds it, or the turn would run in another
  // scope (none at all would fall back to the agent's stored level). Fail
  // closed.
  if (agent.workspaceId !== team.workspaceId) {
    throw new Error(
      `Agent '${agent.slug}' does not answer in its workspace: a workspace turn is refused.`,
    );
  }
  return agent;
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

/** Map a thread window into prompt history. Pending/failed rows, the empty
 *  pending bubble and a superseded pair never reach the prompt. Exported for
 *  the isolation tests. */
export function teamThreadToHistory(
  rows: Pick<ThreadMessage, 'status' | 'text' | 'direction' | 'data'>[],
): HistoryTurn[] {
  return rows
    .filter(
      (r) =>
        r.status === 'complete' &&
        r.text.trim().length > 0 &&
        !(r.data && typeof r.data === 'object' && 'superseded_by' in r.data),
    )
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

/**
 * A CLIENT login's chat turn: removed with client chat in workspaces W5c. A
 * turn still queued from before refuses before anything is written and no
 * model is called.
 */
export async function runClientTurn(
  _ownerId: string,
  _text: string,
  _options: RunClientTurnOptions,
): Promise<TeamTurnResult> {
  throw new Error('client turn dropped: client chat was removed');
}

/** Whether `loginId` is a row with a role this code does not name (one
 *  still marked client: none is left after migration 0272, workspaces W8a).
 *  Such a row is no login, and has no chat. */
async function hasUnknownRole(loginId: string): Promise<boolean> {
  const rows = (await db
    .select({ role: authUsers.role })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))) as unknown;
  const role = Array.isArray(rows) ? (rows[0] as { role?: unknown } | undefined)?.role : undefined;
  return typeof role === 'string' && !isLoginRole(role);
}

export async function runTeamTurn(
  ownerId: string,
  text: string,
  options: RunTeamTurnOptions,
): Promise<TeamTurnResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('runTeamTurn: empty text');
  // A turn input from before Phase 6 may still name only a portal contact
  // (a workflow recovered on upgrade): refuse it, as the portal is gone.
  if (!options.loginId) {
    throw new Error('runTeamTurn: loginId required (the team-code portal chat is retired)');
  }
  // A login this code does not name has no chat (W7c fix round 1, M4; W8a):
  // the route refuses it, and so does the engine, before anything is
  // written or a model is called.
  if (await hasUnknownRole(options.loginId)) {
    throw new Error('runTeamTurn: this login has no chat');
  }
  const displayText = options.displayText?.trim() || trimmed;
  const channel: TeamChannel = options.channel ?? 'web';
  const progress: { inboundWritten: boolean; agentId: string | null } = {
    inboundWritten: false,
    agentId: null,
  };
  try {
    return await runTeamTurnSteps(ownerId, trimmed, displayText, channel, options, progress);
  } catch (err) {
    // A turn that fails BEFORE the inbound row is written (no agent, no key,
    // retrieval down) used to leave nothing behind: the route had already
    // answered 202, so the message simply vanished (audit MED 12). Record it
    // with a failed reply, so the thread shows the message and "did not go
    // through". Failures after that point mark their own pending row.
    // A turn whose agent was never resolved has no thread to land in
    // (0269: a row belongs to one agent's thread): only the error is logged.
    const agentId = progress.agentId;
    if (!progress.inboundWritten && agentId) {
      // The member's thread and stream hear a fixed sentence for a provider
      // failure, never the provider's body (logged here, server side).
      const publicText = personProviderErrorMessage(err, 'team-turn');
      await runDurableStep('record_team_failed_early', async () => {
        await appendThreadMessage({
          ownerId,
          agentId,
          loginId: options.loginId,
          direction: 'inbound',
          text: displayText,
          attachments: options.attachments ?? [],
        });
        await appendThreadMessage({
          ownerId,
          agentId,
          loginId: options.loginId,
          direction: 'outbound',
          text: '',
          error: publicText,
        });
      }).catch((e) => console.error('[team-turn] could not record the failed turn:', e));
      if (options.streamId) {
        emitTurnLifecycle(options.streamId, ownerId, 'error', { message: publicText });
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
  progress: { inboundWritten: boolean; agentId: string | null },
): Promise<TeamTurnResult> {
  const { loginId } = options;
  const agent = await resolveMemberAgent(ownerId, options.agentSlug, loginId);
  progress.agentId = agent.id;
  if (!agent.apiKeyId) {
    throw new Error(`Agent '${agent.slug}' has no api_key_id set — edit at /settings/agents.`);
  }
  const credential = await getApiKeyById(agent.apiKeyId);
  if (!credential) {
    throw new Error(`api_key_id ${agent.apiKeyId} not found for agent '${agent.slug}'.`);
  }

  // Everything below runs in the assistant's workspace's turn scope for this login
  // (withAgentViewer): the assistant reads only what row security shows that
  // workspace.
  return withAgentViewer(
    agent,
    async () => {
      // Retrieval context and the login's own digests. The history rows are
      // read here, from the login's own thread with this agent (inside its
      // open chat thread), because the engine needs their ids and marks.
      // Steps before the trace opens (the decider's pruning + hint calls, the
      // query embed) are held here and written into the trace below.
      const prelude = createTracePrelude();
      // The owner's private-reads switch is read BEFORE retrieval: the context
      // loader hides the same node types the read tools do.
      const prefs = await loadProfilePreferences(ownerId);
      const privateReads = isTeamPrivateReadsEnabled(prefs);
      const memoryConfig = (agent.memoryConfig ?? {}) as { history_limit?: number };
      const open = await openChatThread(ownerId, agent.id, loginId);
      const loadedHistoryRows = await recentThreadMessages(
        ownerId,
        agent.id,
        loginId,
        memoryConfig.history_limit ?? 20,
        open?.startedAt ?? null,
      );
      const ctx: ConversationContext = await withTracePrelude(prelude, () =>
        loadConversationContext({
          ownerId,
          agent,
          inboundText: trimmed,
          includeJournal: false,
          excludeNodeTypes: teamHiddenNodeTypes(privateReads),
          // The login's own thread (0269): its digests, and nobody else's.
          loginId,
          loadHistory: false,
          // A short follow-up ("what about in pages?") is enriched from the
          // login's own thread, already read above.
          recentTurnTexts: teamThreadToHistory(loadedHistoryRows).map((t) => t.text),
        }),
      );

      const inbound = await runDurableStep('record_team_inbound', () =>
        appendThreadMessage({
          ownerId,
          agentId: agent.id,
          loginId,
          direction: 'inbound',
          text: displayText,
          attachments: options.attachments ?? [],
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
        appendThreadMessage({
          ownerId,
          agentId: agent.id,
          loginId,
          direction: 'outbound',
          text: '',
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
      const abortController = options.streamId
        ? registerTurnAbort(options.streamId, ownerId)
        : null;
      const retireAbort = () => {
        if (options.streamId) unregisterTurnAbort(options.streamId);
      };

      // Member identity rides the VOLATILE block: per-contact text in the cached
      // prefix would bust the shared per-agent cache on every member switch.
      const memberLine = `Team member: ${options.contactName ?? 'unknown name'} (user ${loginId}). You are serving this person: a member of the team, not the brain's owner.`;

      // Shared responder-turn assembly (audit #5c), configured for the team
      // surface's HARD isolation: no identity/journal block, no heartbeats, no
      // owner thinking budget (an effort set on the responder agent itself
      // still applies). Delegation: the workspace delegates of the agent's
      // delegate_to only (Draftsman, Presenter, Appsmith; owner decision
      // 2026-10-26), which the assembly and the delegation gateway read from
      // this turn's scope; the child runs in this scope, on this surface,
      // with this login's rights. The private-reads
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
          excludePrivateCorpus: !privateReads,
        }),
      );
      const { volatileContext } = assembled;

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
        // HARD isolation: no persona notes; owner-personal context never
        // reaches a workspace turn. The digests are this login's own (0269).
        personaNotes: [],
        facts: ctx.facts,
        digests: ctx.digests,
        contentHits: ctx.contentHits,
        chunkHits: ctx.chunkHits,
        relations: ctx.relations,
        history,
        newUserText: trimmed,
      });

      let capturedTraceId: string | null = null;
      let outcome: ResponderLoopResult;
      // The trace's tokens at its close, for the ledger slot (onClose).
      const closed: { tokens: { in: number; out: number } | null } = { tokens: null };
      try {
        outcome = await startTrace(
          {
            kind: 'responder_turn',
            prelude,
            ownerId,
            loginId,
            turnId: options.streamId,
            subjectId: inbound.id,
            subjectKind: 'team_turn',
            agentId: agent.id,
            // The turn's tokens and its delegated children's: a delegation
            // spends on this member's budget too.
            onClose: (t, delegated) => {
              closed.tokens = { in: t.in + delegated.in, out: t.out + delegated.out };
            },
            data: {
              surface: 'team',
              contact_id: null,
              login_id: loginId,
              channel,
              model: agent.model,
              agent_slug: agent.slug,
              // tool_count: what the model is sent, recorded by the loop
              // (recordToolCount).
            },
          },
          async () => {
            capturedTraceId = currentTrace()?.id ?? null;
            return runResponderLoop({
              ownerId,
              agent,
              adapter,
              credential,
              prefs,
              logPrefix: '[team-turn]',
              recordToolCount: true,
              // Delegation is the workspace delegates only (assembled.delegateTo,
              // and the gateway at the call). `assembled` also
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
              surface: {
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
          const msg = personProviderErrorMessage(err, 'team-turn');
          await runDurableStep('fail_team_outbound', () =>
            updateThreadMessageOutcome({
              ownerId,
              loginId,
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
      } finally {
        // Success or failure: the tokens the turn spent count on its slot.
        const ledgerTurnId = options.ledgerTurnId;
        const spent = closed.tokens;
        if (ledgerTurnId && spent && spent.in + spent.out > 0) {
          await settleMemberTurn(loginId, ledgerTurnId, spent.in + spent.out).catch((e: unknown) =>
            log('team-turn').error('could not stamp the turn tokens on its slot:', e),
          );
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
        updateThreadMessageOutcome({
          ownerId,
          loginId,
          id: outboundPending.id,
          status: 'complete',
          text: reply,
          model: agent.model,
          traceId: capturedTraceId,
          usedPrivate,
          ...(durableAttachments.length ? { attachments: durableAttachments } : {}),
        }),
      );
      const outbound: ThreadMessage = finalized ?? {
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
    },
    { loginId },
  );
}
