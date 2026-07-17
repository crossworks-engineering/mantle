/**
 * Team Forum turn execution — the agent answering a member's post in a SHARED
 * topic, against the same permission-limited `team-responder` agent as Team
 * Chat. A sibling of runTeamTurn with three deliberate differences:
 *
 *   1. The inbound is NOT persisted here — the route already appended the
 *      member's post (it must appear to every member instantly, even while
 *      this turn waits in the queue). This runner receives topicId +
 *      inboundPostId and answers into the topic.
 *   2. History is the TOPIC transcript, multi-author: member and owner posts
 *      become user turns prefixed with the author's name (consecutive ones
 *      coalesced into a single turn so providers that require strict
 *      user/assistant alternation never see back-to-back user messages);
 *      agent posts become assistant turns. The volatile block tells the
 *      model it is speaking to a room, not one person.
 *   3. Serial-per-topic is enforced UPSTREAM by the partitioned FORUM_QUEUE
 *      (concurrency 1 per topicId) — this workflow only runs when it is this
 *      topic's turn, so there is NO in-workflow wait. Consequences the old
 *      spin-lock got wrong and this design gets right:
 *        - History loads at the TOP, when the turn actually runs, so a queued
 *          turn sees every prior turn's ANSWER (not a stale pre-wait snapshot).
 *        - The pending "thinking…" insert is idempotent on the workflow id
 *          (acquireForumAgentPending), so a DBOS replay adopts its own row
 *          instead of deadlocking on the unique index.
 *        - The trigger post is fetched BY ID, never through the recency window
 *          (it can't fall out of a window that no longer gates history).
 *
 * Isolation invariants are IDENTICAL to runTeamTurn (no persona notes, no
 * digests, no owner journal/identity; private reads stripped unless the
 * owner's pref allows) — tested in run-forum-turn.test.ts.
 */

import { and, eq } from 'drizzle-orm';
import { db, agents, type Agent, type ForumPost, type TeamChannel } from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import {
  buildChatMessages,
  loadConversationContext,
  type HistoryTurn,
} from '@mantle/agent-runtime';
import { getChatAdapter, stripAudioTags } from '@mantle/voice';
import {
  acquireForumAgentPending,
  finalizeForumPost,
  getForumPost,
  getForumTopic,
  recentForumPosts,
  sweepStaleForumAgentPosts,
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
import { TEAM_RESPONDER_SLUG } from './run-team-turn';

export type RunForumTurnOptions = {
  /** The member whose post triggered this turn (authenticated surface). */
  contactId: string;
  contactName?: string;
  /** The shared topic being answered into. */
  topicId: string;
  /** The already-persisted forum_posts row that triggered this turn. */
  inboundPostId: string;
  channel?: TeamChannel;
  /** Server-minted correlation id for live streaming, in the shared
   *  `team-<contactId>.<nonce>` namespace so the existing team stream route
   *  serves forum turns unchanged. */
  streamId?: string;
  /** DBOS workflow id (from the workflow wrapper) — the idempotency key for the
   *  agent pending row on a recovery replay. Required. */
  workflowId?: string;
};

export type ForumTurnResult = {
  outbound: ForumPost;
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

/** A user-turn line for a human post: name-prefixed so the model can track
 *  who said what in a multi-author room. */
function humanLine(post: ForumPost): string {
  const who = post.authorKind === 'owner' ? `${post.authorName} (brain owner)` : post.authorName;
  return `${who}: ${post.body}`;
}

/**
 * Map a topic transcript into prompt history. Pending/failed rows never reach
 * the prompt; human posts are name-prefixed user turns with CONSECUTIVE user
 * turns coalesced (strict-alternation providers reject back-to-back user
 * messages); agent posts are assistant turns. Exported for the isolation tests.
 */
export function forumPostsToHistory(posts: ForumPost[]): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const p of posts) {
    if (p.status !== 'complete' || p.body.trim().length === 0) continue;
    if (p.authorKind === 'agent') {
      out.push({ role: 'assistant', text: p.body });
      continue;
    }
    const line = humanLine(p);
    const prev = out[out.length - 1];
    if (prev && prev.role === 'user') prev.text = `${prev.text}\n\n${line}`;
    else out.push({ role: 'user', text: line });
  }
  return out;
}

export async function runForumTurn(
  ownerId: string,
  options: RunForumTurnOptions,
): Promise<ForumTurnResult> {
  const { contactId, topicId, inboundPostId, workflowId } = options;
  if (!contactId) throw new Error('runForumTurn: contactId required');
  if (!topicId) throw new Error('runForumTurn: topicId required');
  if (!inboundPostId) throw new Error('runForumTurn: inboundPostId required');
  if (!workflowId) throw new Error('runForumTurn: workflowId required');
  const channel: TeamChannel = options.channel ?? 'web';

  // Every failure path must reach the member. Without a universal terminal
  // emit, a throw BEFORE the trace (misconfig, topic/trigger gone) would leave
  // the SSE stream pinging and the composer stuck on "Thinking…" forever.
  let outboundPending: ForumPost | null = null;
  let terminalEmitted = false;
  const emitError = (message: string) => {
    if (options.streamId && !terminalEmitted) {
      emitTurnLifecycle(options.streamId, ownerId, 'error', { message });
      terminalEmitted = true;
    }
  };
  const retireAbort = () => {
    if (options.streamId) unregisterTurnAbort(options.streamId);
  };

  try {
    const agent = await resolveTeamResponder(ownerId);
    if (!agent) {
      throw new Error(
        "The Team Forum isn't provisioned on this brain — the 'team-responder' agent is missing or disabled.",
      );
    }
    if (!agent.apiKeyId) {
      throw new Error(`Agent '${agent.slug}' has no api_key_id set — edit at /settings/agents.`);
    }
    const apiKey = await getApiKeyById(agent.apiKeyId);
    if (!apiKey) {
      throw new Error(`api_key_id ${agent.apiKeyId} not found for agent '${agent.slug}'.`);
    }

    // Owner viewer: the runner is trusted and must load private topics too
    // (their author is the one asking in them).
    const topic = await getForumTopic(ownerId, topicId, { kind: 'owner' });
    if (!topic) throw new Error(`runForumTurn: topic ${topicId} not found`);

    // Fetch the trigger BY ID (not through a window), and load history at the
    // TOP of the turn: the partitioned queue guarantees this runs only when it
    // is this topic's turn, so the transcript already contains every PRIOR
    // turn's ANSWER. Exclude only the trigger (it becomes the new user
    // message) — NO createdAt window, which is what fixes the stale-history bug.
    const trigger = await getForumPost(ownerId, topicId, inboundPostId);
    if (!trigger) throw new Error(`runForumTurn: triggering post ${inboundPostId} not found`);

    const memoryConfig = (agent.memoryConfig ?? {}) as { history_limit?: number };
    const transcript = await recentForumPosts(ownerId, topicId, memoryConfig.history_limit ?? 30);
    const history = forumPostsToHistory(transcript.filter((p) => p.id !== trigger.id));
    const newUserText = humanLine(trigger);

    // Retrieval context (the team-responder's own history is structurally
    // empty; digests are off via its memoryConfig — see runTeamTurn).
    const ctx = await loadConversationContext({ ownerId, agent, inboundText: trigger.body });

    // Belt-and-suspenders: fail out any TRULY abandoned (>15min) pending so a
    // wedged topic self-heals even before the P1 global sweep worker. The
    // FORUM_QUEUE already serializes, so this never touches a healthy turn.
    await sweepStaleForumAgentPosts(ownerId, topicId);

    // Take the topic's single "thinking…" slot — idempotent on workflowId, so a
    // recovery replay adopts its own row instead of tripping the unique index.
    const pending = await runDurableStep('record_forum_outbound_pending', () =>
      acquireForumAgentPending({
        ownerId,
        topicId,
        agentId: agent.id,
        agentName: agent.name ?? agent.slug,
        model: agent.model,
        channel,
        workflowId,
      }),
    );
    outboundPending = pending;

    if (options.streamId) {
      emitTurnLifecycle(options.streamId, ownerId, 'turn-start', {
        agentSlug: agent.slug,
        model: agent.model,
        inboundId: inboundPostId,
        outboundId: pending.id,
      });
    }
    const abortController = options.streamId ? registerTurnAbort(options.streamId, ownerId) : null;

    const prefs = await loadProfilePreferences(ownerId);
    // Per-member and per-topic text rides the VOLATILE block — the cached
    // system prefix stays shared across members and topics.
    const memberLine = `Team member: ${options.contactName ?? 'unknown name'} (contact ${contactId}). You are serving this person — an external team member, not the brain's owner.`;
    const topicLine =
      `Forum topic: "${topic.title}" (kind ${topic.kind}, ${topic.status}${topic.visibility === 'private' ? ', PRIVATE — visible to its author and the owner only' : ''}). ` +
      "You are answering in a shared team forum: every team member can read this thread, and user messages are prefixed with their author's name. " +
      'Address the member whose post you are answering, but write for the room.';

    const assembled = await assembleResponderTurn({
      ownerId,
      agent,
      prefs,
      logPrefix: '[forum-turn]',
      includeIdentity: false,
      volatileExtras: [memberLine, topicLine],
      withThinking: false,
      allowDelegation: false,
      excludeToolSlugs: isTeamPrivateReadsEnabled(prefs) ? [] : TEAM_PRIVATE_READ_SLUGS,
    });
    const { volatileContext, allowedTools } = assembled;

    const adapter = getChatAdapter(agent.provider);
    if (!adapter) {
      throw new Error(
        `forum turn: no chat adapter for provider '${agent.provider}' (agent ${agent.slug})`,
      );
    }

    const messages = buildChatMessages({
      model: agent.model,
      provider: agent.provider,
      systemPrompt: assembled.effectiveSystemPrompt,
      volatileContext,
      // HARD isolation, exactly as runTeamTurn: no persona notes, no digests.
      personaNotes: [],
      facts: ctx.facts,
      digests: [],
      contentHits: ctx.contentHits,
      chunkHits: ctx.chunkHits,
      relations: ctx.relations,
      history,
      newUserText,
    });

    let capturedTraceId: string | null = null;
    let outcome: ResponderLoopResult;
    try {
      outcome = await startTrace(
        {
          kind: 'responder_turn',
          ownerId,
          turnId: options.streamId,
          subjectId: inboundPostId,
          subjectKind: 'forum_turn',
          agentId: agent.id,
          data: {
            surface: 'forum',
            contact_id: contactId,
            topic_id: topicId,
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
            logPrefix: '[forum-turn]',
            assembled,
            loadContext: async () => ctx,
            contextStepInput: { agentId: agent.id, contactId },
            contextStepExtra: { turnCount: history.length, topicId },
            buildMessages: () => messages,
            // The provenance channel: team_request_create reads WHO is asking
            // and WHICH topic from here; owner-side tools see 'forum' and refuse.
            surface: {
              kind: 'forum',
              contactId,
              contactName: options.contactName,
              topicId,
              inboundPostId,
            },
            abortSignal: abortController?.signal ?? null,
          });
        },
      );
    } catch (err) {
      // A deliberate abort is not a failure — keep the partial reply. Any other
      // error propagates to the outer catch, which fails the pending + emits.
      if (!abortController?.signal.aborted) throw err;
      outcome = {
        loop: emptyLoopResult(),
        reply: '',
        emptyReplySubstituted: false,
        persistedThoughts: [],
        toolStats: null,
        ctx,
      };
    }

    const reply = stripAudioTags(outcome.reply).text;

    const finalized = await runDurableStep('finalize_forum_outbound', () =>
      finalizeForumPost({
        ownerId,
        id: pending.id,
        status: 'complete',
        body: reply,
        model: agent.model,
        traceId: capturedTraceId,
      }),
    );
    const outbound: ForumPost = finalized ?? {
      ...pending,
      body: reply,
      status: 'complete',
      traceId: capturedTraceId,
    };

    retireAbort();
    if (options.streamId) {
      emitTurnLifecycle(options.streamId, ownerId, 'done', {
        outboundId: pending.id,
        tokensOut: outcome.loop.tokensOut,
      });
      terminalEmitted = true;
    }

    return { outbound, reply };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fail the pending (if we got that far) so no member is left with a
    // permanent "answering…" bubble, and make sure the stream terminates.
    if (outboundPending) {
      await runDurableStep('fail_forum_outbound', () =>
        finalizeForumPost({ ownerId, id: outboundPending!.id, status: 'failed', error: msg }),
      ).catch((e) => console.error('[forum-turn] could not mark turn failed:', e));
    }
    emitError(msg);
    retireAbort();
    throw err;
  }
}
