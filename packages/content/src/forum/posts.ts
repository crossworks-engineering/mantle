/**
 * Forum · post lifecycle. Appending a post, and the three-step dance the agent
 * turn pipeline runs around a DURABLE pending row: acquire (insert the
 * "thinking…" bubble), read the trigger, finalize (fill the body) — plus the
 * sweep that fails a bubble whose worker died mid-turn.
 *
 * The pending row is durable on purpose: a crashed turn must leave a visible,
 * recoverable post rather than a thread that silently never answers.
 */
import { and, eq, lt, sql as dsql } from 'drizzle-orm';
import {
  db,
  forumPosts,
  forumTopics,
  type ConversationAttachment,
  type ForumPost,
  type ForumPostRequestKind,
  type TeamChannel,
} from '@mantle/db';
import { canPostToTopic, type ForumAuthor } from '../forum-visibility';
import { bindForumUploadsTx } from '../forum-uploads';
import { memberName } from './shared';

export type AppendForumPostInput = {
  ownerId: string;
  topicId: string;
  author: ForumAuthor;
  body: string;
  channel?: TeamChannel;
  attachments?: ConversationAttachment[];
  /** Staged forum_uploads ids the attachments reference — bound to this post
   *  inside its transaction (see CreateForumTopicInput). Member authors only. */
  bindUploadIds?: string[];
  /** Set when this post files a review/feature/bug request (Phase 2). */
  requestKind?: ForumPostRequestKind;
  /** Set on owner posts delivered from the review queue (Phase 2). */
  sourceRequestTaskId?: string;
  model?: string | null;
  traceId?: string | null;
  error?: string | null;
  /** 'pending' inserts the durable "thinking…" bubble the turn pipeline
   *  finalizes later. Ignored when `error` is set (that's always 'failed'). */
  status?: 'pending' | 'complete';
};

/**
 * Append one post and bump the topic's denormalized activity columns in the
 * same transaction. Enforces existence + member visibility (a member cannot
 * post into another member's private topic) — the closed-topic rule for
 * members is the API layer's job, since the owner and the agent may still
 * post into any topic.
 */
export async function appendForumPost(input: AppendForumPostInput): Promise<ForumPost> {
  const body = input.body.trim();
  if (!body && !input.status) throw new Error('forum: a post body is required');

  const [topic] = await db
    .select()
    .from(forumTopics)
    .where(and(eq(forumTopics.id, input.topicId), eq(forumTopics.ownerId, input.ownerId)))
    .limit(1);
  if (!topic) throw new Error('forum: topic not found');
  // Single source of truth for the write-visibility rule (forum-visibility.ts).
  // A member may not post into another member's private topic; owner + agent
  // may post anywhere. Indistinguishable from absent, on purpose.
  if (!canPostToTopic(input.author, topic)) {
    throw new Error('forum: topic not found');
  }

  const authorName =
    input.author.kind === 'member'
      ? await memberName(input.ownerId, input.author.contactId)
      : input.author.name;
  const uploadContactId = input.author.kind === 'member' ? input.author.contactId : null;
  if (input.bindUploadIds?.length && !uploadContactId) {
    throw new Error('forum: only member posts carry uploads');
  }

  return db.transaction(async (tx) => {
    const [post] = await tx
      .insert(forumPosts)
      .values({
        ownerId: input.ownerId,
        topicId: input.topicId,
        authorKind: input.author.kind,
        contactId: input.author.kind === 'member' ? input.author.contactId : null,
        authorName,
        agentId: input.author.kind === 'agent' ? input.author.agentId : null,
        model: input.model ?? null,
        traceId: input.traceId ?? null,
        body,
        attachments: input.attachments ?? [],
        kind: input.requestKind ?? null,
        sourceRequestTaskId: input.sourceRequestTaskId ?? null,
        channel: input.channel ?? 'web',
        error: input.error ?? null,
        status: input.error ? 'failed' : (input.status ?? 'complete'),
      })
      .returning();
    if (!post) throw new Error('forum: post insert returned no row');
    if (input.bindUploadIds?.length && uploadContactId) {
      await bindForumUploadsTx(tx, {
        ownerId: input.ownerId,
        contactId: uploadContactId,
        topicId: input.topicId,
        postId: post.id,
        ids: input.bindUploadIds,
      });
    }
    const now = new Date();
    await tx
      .update(forumTopics)
      .set({
        postCount: dsql`${forumTopics.postCount} + 1`,
        lastPostAt: now,
        updatedAt: now,
      })
      .where(eq(forumTopics.id, input.topicId));
    return post;
  });
}

export type AcquireForumAgentPendingInput = {
  ownerId: string;
  topicId: string;
  agentId: string;
  agentName: string;
  model?: string | null;
  channel?: TeamChannel;
  /** The DBOS forum-turn workflow id — the idempotency key on replay. */
  workflowId: string;
};

/**
 * Take the topic's single agent "thinking…" pending slot for a forum turn,
 * IDEMPOTENTLY on `workflowId`. If this workflow already inserted its pending
 * row (a DBOS recovery replay after a crash between commit and step-journal),
 * adopt it; otherwise insert one and bump the topic's activity counters.
 *
 * The partitioned FORUM_QUEUE (concurrency 1 per topic) is the real serializer,
 * so at most one turn runs per topic and the one-pending-per-topic unique index
 * is a backstop, never a contention point — a healthy turn never conflicts, and
 * a replay finds its OWN row here instead of tripping the index.
 */
export async function acquireForumAgentPending(
  input: AcquireForumAgentPendingInput,
): Promise<ForumPost> {
  const [existing] = await db
    .select()
    .from(forumPosts)
    .where(
      and(
        eq(forumPosts.ownerId, input.ownerId),
        eq(forumPosts.topicId, input.topicId),
        eq(forumPosts.authorKind, 'agent'),
        eq(forumPosts.status, 'pending'),
        eq(forumPosts.workflowId, input.workflowId),
      ),
    )
    .limit(1);
  if (existing) return existing;

  return db.transaction(async (tx) => {
    const [post] = await tx
      .insert(forumPosts)
      .values({
        ownerId: input.ownerId,
        topicId: input.topicId,
        authorKind: 'agent',
        authorName: input.agentName,
        agentId: input.agentId,
        model: input.model ?? null,
        body: '',
        channel: input.channel ?? 'web',
        status: 'pending',
        workflowId: input.workflowId,
      })
      .returning();
    if (!post) throw new Error('forum: agent pending insert returned no row');
    const now = new Date();
    await tx
      .update(forumTopics)
      .set({
        postCount: dsql`${forumTopics.postCount} + 1`,
        lastPostAt: now,
        updatedAt: now,
      })
      .where(eq(forumTopics.id, input.topicId));
    return post;
  });
}

/** One post by id, owner+topic-scoped. The turn pipeline fetches its trigger
 *  through this — by id, NOT through the recency window (on a busy topic the
 *  trigger can fall out of the window while the turn is queued). Null if gone. */
export async function getForumPost(
  ownerId: string,
  topicId: string,
  postId: string,
): Promise<ForumPost | null> {
  const [row] = await db
    .select()
    .from(forumPosts)
    .where(
      and(
        eq(forumPosts.ownerId, ownerId),
        eq(forumPosts.topicId, topicId),
        eq(forumPosts.id, postId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type FinalizeForumPostInput = {
  ownerId: string;
  id: string;
  status: 'complete' | 'failed';
  body?: string;
  model?: string | null;
  traceId?: string | null;
  error?: string | null;
  /** Media the turn's tools produced — node references only, never bytes. A
   *  member reads these through /api/team/forum/media/<nodeId>, which
   *  authorizes off THIS column. See run-forum-turn.ts. */
  attachments?: ConversationAttachment[];
};

/** Finalize a pending agent post (the durable "thinking…" bubble): fill the
 *  reply + flip status, or mark it failed. Mirrors updateTeamMessageOutcome.
 *  The `status = 'pending'` guard is load-bearing: a row already resolved
 *  (e.g. swept to 'failed', or a double finalize on replay) is NOT overwritten,
 *  so a late-completing turn can't resurrect a failed post into a duplicate
 *  answer. Returns the updated row, or null when nothing pending matched. */
export async function finalizeForumPost(args: FinalizeForumPostInput): Promise<ForumPost | null> {
  const [row] = await db
    .update(forumPosts)
    .set({
      status: args.status,
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
    })
    .where(
      and(
        eq(forumPosts.ownerId, args.ownerId),
        eq(forumPosts.id, args.id),
        eq(forumPosts.status, 'pending'),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Fail out abandoned in-flight agent posts on a topic (pending older than
 * `olderThanMinutes`). The partial unique index serializes agent turns on the
 * pending row — this sweep guarantees a crashed-and-forgotten turn can never
 * wedge its topic. Returns how many rows were failed.
 */
export async function sweepStaleForumAgentPosts(
  ownerId: string,
  topicId: string,
  olderThanMinutes = 15,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const rows = await db
    .update(forumPosts)
    .set({ status: 'failed', error: 'turn abandoned (stale pending sweep)' })
    .where(
      and(
        eq(forumPosts.ownerId, ownerId),
        eq(forumPosts.topicId, topicId),
        eq(forumPosts.authorKind, 'agent'),
        eq(forumPosts.status, 'pending'),
        lt(forumPosts.createdAt, cutoff),
      ),
    )
    .returning({ id: forumPosts.id });
  return rows.length;
}
