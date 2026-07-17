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
 *   3. Serial-per-topic: the durable "thinking…" post is guarded by a partial
 *      unique index (one pending agent post per topic). A concurrent turn's
 *      insert conflicts and retries with backoff; a stale-pending sweep
 *      guarantees an abandoned turn can never wedge its topic.
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
  appendForumPost,
  finalizeForumPost,
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
  /** Server-minted correlation id for live streaming (forum-<contactId>.<nonce>). */
  streamId?: string;
};

export type ForumTurnResult = {
  outbound: ForumPost;
  reply: string;
};

/** How long a concurrent turn waits for the topic's in-flight agent post to
 *  clear before giving up (the queue itself retries nothing beyond this). */
const PENDING_WAIT_MS = 4 * 60_000;
const PENDING_POLL_MS = 2_000;

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

/** Postgres unique-violation on the one-pending-agent-post-per-topic index —
 *  another turn holds the topic. */
function isPendingConflict(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = err; e && typeof e === 'object' && !seen.has(e); ) {
    seen.add(e);
    const rec = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (rec.code === '23505') return true;
    if (
      typeof rec.message === 'string' &&
      rec.message.includes('forum_posts_one_pending_agent_idx')
    ) {
      return true;
    }
    e = rec.cause;
  }
  return false;
}

export async function runForumTurn(
  ownerId: string,
  options: RunForumTurnOptions,
): Promise<ForumTurnResult> {
  const { contactId, topicId, inboundPostId } = options;
  if (!contactId) throw new Error('runForumTurn: contactId required');
  if (!topicId) throw new Error('runForumTurn: topicId required');
  if (!inboundPostId) throw new Error('runForumTurn: inboundPostId required');
  const channel: TeamChannel = options.channel ?? 'web';

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

  // The topic frames the whole turn. Owner viewer: the runner is trusted and
  // must load private topics too (their author is the one asking in them).
  const topic = await getForumTopic(ownerId, topicId, { kind: 'owner' });
  if (!topic) throw new Error(`runForumTurn: topic ${topicId} not found`);

  const memoryConfig = (agent.memoryConfig ?? {}) as { history_limit?: number };
  const transcript = await recentForumPosts(ownerId, topicId, memoryConfig.history_limit ?? 30);
  const trigger = transcript.find((p) => p.id === inboundPostId);
  if (!trigger) {
    // Outside the recency window or deleted — either way there is nothing
    // trustworthy to answer.
    throw new Error(`runForumTurn: triggering post ${inboundPostId} not found in topic window`);
  }
  const history = forumPostsToHistory(
    transcript.filter((p) => p.createdAt < trigger.createdAt && p.id !== trigger.id),
  );
  const newUserText = humanLine(trigger);

  // Retrieval context (the team-responder's own history is structurally
  // empty; digests are off via its memoryConfig — see runTeamTurn).
  const ctx = await loadConversationContext({ ownerId, agent, inboundText: trigger.body });

  // Serial-per-topic gate: sweep abandoned pendings, then take the topic's
  // pending slot — the partial unique index makes the insert the lock.
  const outboundPending = await runDurableStep('record_forum_outbound_pending', async () => {
    await sweepStaleForumAgentPosts(ownerId, topicId);
    const deadline = Date.now() + PENDING_WAIT_MS;
    for (;;) {
      try {
        return await appendForumPost({
          ownerId,
          topicId,
          author: { kind: 'agent', agentId: agent.id, name: agent.name ?? agent.slug },
          body: '',
          channel,
          model: agent.model,
          status: 'pending',
        });
      } catch (err) {
        if (!isPendingConflict(err)) throw err;
        if (Date.now() >= deadline) {
          throw new Error(
            `runForumTurn: topic ${topicId} still has an in-flight agent turn after ${PENDING_WAIT_MS / 1000}s`,
          );
        }
        await new Promise((r) => setTimeout(r, PENDING_POLL_MS));
        await sweepStaleForumAgentPosts(ownerId, topicId);
      }
    }
  });

  if (options.streamId) {
    emitTurnLifecycle(options.streamId, ownerId, 'turn-start', {
      agentSlug: agent.slug,
      model: agent.model,
      inboundId: inboundPostId,
      outboundId: outboundPending.id,
    });
  }
  const abortController = options.streamId ? registerTurnAbort(options.streamId, ownerId) : null;
  const retireAbort = () => {
    if (options.streamId) unregisterTurnAbort(options.streamId);
  };

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
      await runDurableStep('fail_forum_outbound', () =>
        finalizeForumPost({
          ownerId,
          id: outboundPending.id,
          status: 'failed',
          error: msg,
          traceId: capturedTraceId,
        }),
      ).catch((e) => console.error('[forum-turn] could not mark turn failed:', e));
      if (options.streamId) emitTurnLifecycle(options.streamId, ownerId, 'error', { message: msg });
      retireAbort();
      throw err;
    }
  }

  const reply = stripAudioTags(outcome.reply).text;

  const finalized = await runDurableStep('finalize_forum_outbound', () =>
    finalizeForumPost({
      ownerId,
      id: outboundPending.id,
      status: 'complete',
      body: reply,
      model: agent.model,
      traceId: capturedTraceId,
    }),
  );
  const outbound: ForumPost = finalized ?? {
    ...outboundPending,
    body: reply,
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

  return { outbound, reply };
}
