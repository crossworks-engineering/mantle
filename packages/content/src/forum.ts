/**
 * Team Forum store — shared topic threads, the successor to the per-contact
 * Team Chat forever-thread. Topics are titled multi-author threads every
 * member can read (visibility 'team'); 'private' topics are author + owner
 * only. Writers are the forum API routes (member/owner posts), the forum turn
 * pipeline (agent posts, durable-pending like team_messages), and — Phase 2 —
 * the review loop delivering owner resolutions back into their topic.
 *
 * Author identity is snapshotted (`author_name`) and `contact_id` goes SET
 * NULL on contact deletion: forum content is team knowledge and outlives its
 * author, deliberately unlike team_messages. Member names are resolved HERE
 * from the contact node — callers never supply a member display name.
 */
import { and, asc, count, desc, eq, gte, ilike, lt, or, sql as dsql } from 'drizzle-orm';
import {
  db,
  forumPosts,
  forumReadCursors,
  forumTopics,
  nodes,
  type ConversationAttachment,
  type ForumPost,
  type ForumPostRequestKind,
  type ForumTopic,
  type ForumTopicKind,
  type ForumTopicStatus,
  type ForumTopicVisibility,
  type TeamChannel,
} from '@mantle/db';
import {
  canPostToTopic,
  canViewTopic,
  type ForumAuthor,
  type ForumViewer,
} from './forum-visibility';
import { matchSnippet } from './forum-search';
import { bindForumUploadsTx } from './forum-uploads';

// Re-exported so existing importers (index.ts, callers) keep resolving these
// from '@mantle/content'; the definitions live in forum-visibility.ts, next to
// the predicates that are the single source of truth for the rule.
export type { ForumViewer, ForumAuthor };

const TITLE_MAX = 200;

/** SQL form of the read-visibility rule for the LIST/GET queries. MUST mirror
 *  `canViewTopic` (forum-visibility.ts) — that pure predicate is the source of
 *  truth and is the belt to this SQL's suspenders (getForumTopic re-checks it
 *  post-fetch). Owner ⇒ no filter (sees all); member ⇒ 'team' OR own topic. */
function visibleTopicCond(viewer: ForumViewer) {
  if (viewer.kind === 'owner') return undefined;
  return or(
    eq(forumTopics.visibility, 'team'),
    eq(forumTopics.createdByContactId, viewer.contactId),
  );
}

/** SQL for the forum topic search: matches the topic TITLE, or any non-pending
 *  post BODY in the topic (so "find the thread where X was discussed" works,
 *  not just title hits). Case-insensitive substring. Undefined when no query. */
function topicSearchCond(query?: string) {
  const q = query?.trim();
  if (!q) return undefined;
  const like = `%${q}%`;
  return or(
    ilike(forumTopics.title, like),
    dsql`exists (
      select 1 from forum_posts p
      where p.topic_id = ${forumTopics.id}
        and p.status <> 'pending'
        and p.body ilike ${like}
    )`,
  );
}

/** Resolve a member's display name from their contact node — the one true
 *  source; never caller-supplied. Throws if the contact is gone (a live team
 *  token cannot outlive its contact, so this indicates a revoked caller). */
async function memberName(ownerId: string, contactId: string): Promise<string> {
  const [row] = await db
    .select({ title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.id, contactId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!row) throw new Error('forum: contact not found');
  return row.title ?? '(unnamed contact)';
}

export type CreateForumTopicInput = {
  ownerId: string;
  title: string;
  /** Body of the opening post. */
  body: string;
  kind?: ForumTopicKind;
  visibility?: ForumTopicVisibility;
  author: Exclude<ForumAuthor, { kind: 'agent' }>;
  channel?: TeamChannel;
  attachments?: ConversationAttachment[];
  /** Staged forum_uploads ids the attachments reference (attachment.fileId).
   *  Bound to the opening post INSIDE the create transaction — a failed bind
   *  rolls the topic back. Member authors only. */
  bindUploadIds?: string[];
};

/** Create a topic together with its opening post (one transaction — a topic
 *  with zero posts cannot exist). Returns both rows. */
export async function createForumTopic(
  input: CreateForumTopicInput,
): Promise<{ topic: ForumTopic; post: ForumPost }> {
  const title = input.title.trim().slice(0, TITLE_MAX);
  const body = input.body.trim();
  if (!title) throw new Error('forum: a topic title is required');
  if (!body) throw new Error('forum: an opening post is required');

  const authorName =
    input.author.kind === 'member'
      ? await memberName(input.ownerId, input.author.contactId)
      : input.author.name;
  const contactId = input.author.kind === 'member' ? input.author.contactId : null;
  if (input.bindUploadIds?.length && !contactId) {
    throw new Error('forum: only member posts carry uploads');
  }

  return db.transaction(async (tx) => {
    const [topic] = await tx
      .insert(forumTopics)
      .values({
        ownerId: input.ownerId,
        title,
        kind: input.kind ?? 'question',
        visibility: input.visibility ?? 'team',
        createdByContactId: contactId,
        authorName,
        postCount: 1,
      })
      .returning();
    if (!topic) throw new Error('forum: topic insert returned no row');
    const [post] = await tx
      .insert(forumPosts)
      .values({
        ownerId: input.ownerId,
        topicId: topic.id,
        authorKind: input.author.kind,
        contactId,
        authorName,
        body,
        channel: input.channel ?? 'web',
        attachments: input.attachments ?? [],
      })
      .returning();
    if (!post) throw new Error('forum: post insert returned no row');
    if (input.bindUploadIds?.length && contactId) {
      await bindForumUploadsTx(tx, {
        ownerId: input.ownerId,
        contactId,
        topicId: topic.id,
        postId: post.id,
        ids: input.bindUploadIds,
      });
    }
    return { topic, post };
  });
}

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

export type ForumTopicListItem = {
  id: string;
  title: string;
  kind: ForumTopicKind;
  visibility: ForumTopicVisibility;
  pinned: boolean;
  status: ForumTopicStatus;
  authorName: string;
  createdByContactId: string | null;
  postCount: number;
  lastPostAt: string;
  createdAt: string;
  lastPostAuthor: string | null;
  lastPostPreview: string | null;
  /** Posts by OTHERS since this viewer last read the topic (all of them when
   *  never read). Drives the unread dot. */
  unread: number;
};

/** The reader id a viewer's cursors are keyed by (owner cursors use ownerId). */
function readerIdOf(ownerId: string, viewer: ForumViewer): string {
  return viewer.kind === 'owner' ? ownerId : viewer.contactId;
}

/** Sort orders for the topic index. Pinned topics stay on top in every order
 *  (they're the owner's announcements); the sort ranks the rest. `activity`
 *  (latest post first) is the forum default. */
export const FORUM_TOPIC_SORTS = ['activity', 'newest', 'oldest', 'title'] as const;
export type ForumTopicSort = (typeof FORUM_TOPIC_SORTS)[number];

/**
 * The topic list: pinned first, then the chosen sort (latest activity by
 * default). Visibility-scoped to the viewer, annotated with a last-post
 * preview and the viewer's unread count (posts by others after their cursor —
 * your own posts are never unread to you).
 */
export async function listForumTopics(
  ownerId: string,
  viewer: ForumViewer,
  opts: { limit?: number; offset?: number; query?: string; sort?: ForumTopicSort } = {},
): Promise<ForumTopicListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const sort = opts.sort ?? 'activity';
  const sortOrder =
    sort === 'newest'
      ? desc(forumTopics.createdAt)
      : sort === 'oldest'
        ? asc(forumTopics.createdAt)
        : sort === 'title'
          ? dsql`lower(${forumTopics.title}) ASC`
          : desc(forumTopics.lastPostAt);
  const readerId = readerIdOf(ownerId, viewer);
  const notMine =
    viewer.kind === 'member'
      ? dsql`and (fp.contact_id is distinct from ${viewer.contactId})`
      : dsql`and (fp.author_kind <> 'owner')`;

  const conds = [eq(forumTopics.ownerId, ownerId)];
  const vis = visibleTopicCond(viewer);
  if (vis) conds.push(vis);
  const search = topicSearchCond(opts.query);
  if (search) conds.push(search);

  const rows = await db
    .select({
      id: forumTopics.id,
      title: forumTopics.title,
      kind: forumTopics.kind,
      visibility: forumTopics.visibility,
      pinned: forumTopics.pinned,
      status: forumTopics.status,
      authorName: forumTopics.authorName,
      createdByContactId: forumTopics.createdByContactId,
      postCount: forumTopics.postCount,
      lastPostAt: forumTopics.lastPostAt,
      createdAt: forumTopics.createdAt,
      lastPostAuthor: dsql<string | null>`last_post.author_name`,
      lastPostPreview: dsql<string | null>`last_post.preview`,
      unread: dsql<number>`(
        select count(*)
        from forum_posts fp
        where fp.topic_id = ${forumTopics.id}
          and fp.status <> 'pending'
          and fp.created_at > coalesce(
            (select c.last_read_at from forum_read_cursors c
             where c.owner_id = ${ownerId}
               and c.reader_id = ${readerId}
               and c.topic_id = ${forumTopics.id}),
            'epoch'::timestamptz
          )
          ${notMine}
      )::int`,
    })
    .from(forumTopics)
    .leftJoin(
      dsql`lateral (
        select p.author_name, left(p.body, 160) as preview
        from forum_posts p
        where p.topic_id = ${forumTopics.id} and p.status <> 'pending'
        order by p.created_at desc
        limit 1
      ) last_post`,
      dsql`true`,
    )
    .where(and(...conds))
    .orderBy(desc(forumTopics.pinned), sortOrder)
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    ...r,
    lastPostAt: r.lastPostAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Total topics matching the same visibility + search predicate as
 *  {@link listForumTopics} — the count behind the forum index pager. */
export async function countForumTopics(
  ownerId: string,
  viewer: ForumViewer,
  opts: { query?: string } = {},
): Promise<number> {
  const conds = [eq(forumTopics.ownerId, ownerId)];
  const vis = visibleTopicCond(viewer);
  if (vis) conds.push(vis);
  const search = topicSearchCond(opts.query);
  if (search) conds.push(search);
  const [row] = await db
    .select({ n: count() })
    .from(forumTopics)
    .where(and(...conds));
  return row?.n ?? 0;
}

/** One topic, visibility-enforced for the viewer. Null when absent OR when a
 *  member may not see it — indistinguishable on purpose. */
export async function getForumTopic(
  ownerId: string,
  topicId: string,
  viewer: ForumViewer,
): Promise<ForumTopic | null> {
  const conds = [eq(forumTopics.id, topicId), eq(forumTopics.ownerId, ownerId)];
  const vis = visibleTopicCond(viewer);
  if (vis) conds.push(vis);
  const [row] = await db
    .select()
    .from(forumTopics)
    .where(and(...conds))
    .limit(1);
  if (!row) return null;
  // Belt-and-suspenders: the SQL already filtered, but re-assert the rule
  // through the pure predicate so a future divergence between the two fails
  // CLOSED (null) rather than leaking. Same null on absent-or-forbidden.
  if (!canViewTopic(viewer, row)) return null;
  return row;
}

/**
 * A window of a topic's transcript, newest-first from `before` (exclusive),
 * returned ASCENDING for rendering — the listTeamThread shape. Callers must
 * have resolved the topic through getForumTopic first (visibility lives
 * there, not here).
 */
export async function listForumPosts(
  ownerId: string,
  topicId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<ForumPost[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds = [eq(forumPosts.ownerId, ownerId), eq(forumPosts.topicId, topicId)];
  if (opts.before) {
    const cursor = new Date(opts.before);
    if (!Number.isNaN(cursor.getTime())) conds.push(lt(forumPosts.createdAt, cursor));
  }
  const rows = await db
    .select()
    .from(forumPosts)
    .where(and(...conds))
    .orderBy(desc(forumPosts.createdAt))
    .limit(limit);
  return rows.reverse();
}

export type ForumPostMatch = {
  id: string;
  authorKind: ForumPost['authorKind'];
  authorName: string;
  /** A short excerpt of the post body centred on the first match. */
  snippet: string;
  createdAt: string;
};

/** Posts in ONE topic whose body matches `query` (case-insensitive substring),
 *  newest first — the in-thread search. Only settled, member-visible posts
 *  (`complete`): pending bubbles and failed turns render placeholders in the
 *  thread, so a match there would jump to text the reader can't see.
 *  Visibility is the caller's job (resolve the topic through getForumTopic
 *  first, exactly like listForumPosts). */
export async function searchForumPosts(
  ownerId: string,
  topicId: string,
  opts: { query: string; limit?: number },
): Promise<ForumPostMatch[]> {
  const q = opts.query.trim();
  if (!q) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      id: forumPosts.id,
      authorKind: forumPosts.authorKind,
      authorName: forumPosts.authorName,
      body: forumPosts.body,
      createdAt: forumPosts.createdAt,
    })
    .from(forumPosts)
    .where(
      and(
        eq(forumPosts.ownerId, ownerId),
        eq(forumPosts.topicId, topicId),
        eq(forumPosts.status, 'complete'),
        ilike(forumPosts.body, `%${q}%`),
      ),
    )
    .orderBy(desc(forumPosts.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    authorKind: r.authorKind,
    authorName: r.authorName,
    snippet: matchSnippet(r.body, q),
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Most recent N posts ASCENDING — the turn-context loader shape. */
export async function recentForumPosts(
  ownerId: string,
  topicId: string,
  limit = 30,
): Promise<ForumPost[]> {
  return listForumPosts(ownerId, topicId, { limit });
}

/** Member posts since `since` across ALL topics — the daily-cap gate shared
 *  with Team Chat's philosophy: a leaked token must never drain the wallet. */
export async function countForumMemberPostsSince(
  ownerId: string,
  contactId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(forumPosts)
    .where(
      and(
        eq(forumPosts.ownerId, ownerId),
        eq(forumPosts.contactId, contactId),
        eq(forumPosts.authorKind, 'member'),
        gte(forumPosts.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

// ── Per-member views (the /team-admin Members tab) ────────────────────────
// When the Forum replaced the 1:1 Team Chat, "what has this member been
// doing" lost its home: chat froze, and forum activity is only reachable
// topic-first. These three queries restore the person-first view. They are
// OWNER-side only — no visibility filter, because the owner sees every topic
// including `private` ones (visibleTopicCond returns undefined for owners).
// Do NOT reuse them for a member-facing surface without that filter.

export type ForumMemberActivity = {
  contactId: string;
  postCount: number;
  topicsStarted: number;
  lastPostAt: string | null;
  lastPostBody: string | null;
  lastPostTopicTitle: string | null;
  /** This member's posts newer than the OWNER's read cursor on the containing
   *  topic. Deliberately only cleared by opening the TOPIC — reading someone's
   *  activity feed is not reading the thread the whole room saw. */
  unread: number;
};

/**
 * Forum activity per member, for the admin member index. Keyed by contact;
 * members who have never posted simply don't appear — the caller (which
 * already holds the full roster from `listTeamMemberActivity`) defaults them
 * to zero, so this stays one grouped scan instead of a roster-wide join.
 *
 * Pending posts are excluded: a member post is never pending (only agent
 * bubbles are), so their presence would only ever be a bug leaking in.
 */
export async function listForumMemberActivity(ownerId: string): Promise<ForumMemberActivity[]> {
  type Row = {
    contact_id: string;
    post_count: number;
    topics_started: number;
    /** timestamptz — postgres.js hands these back as Date objects. */
    last_post_at: Date | string | null;
    last_post_body: string | null;
    last_post_topic_title: string | null;
    unread: number;
  };
  // Counts are cast to int4 deliberately: bare count() is int8, which
  // postgres.js returns as a STRING (precision-safe), and these all then
  // arrive as numbers.
  const result = await db.execute<Row>(dsql`
    with mine as (
      select
        fp.contact_id,
        fp.topic_id,
        fp.body,
        fp.created_at,
        -- Resolved per row rather than inside an aggregate FILTER: one cursor
        -- lookup per post, and no subquery in a clause that may not take one.
        (fp.created_at > coalesce(
          (select c.last_read_at from forum_read_cursors c
            where c.owner_id = ${ownerId}
              and c.reader_id = ${ownerId}
              and c.topic_id = fp.topic_id),
          'epoch'::timestamptz
        )) as is_unread
      from forum_posts fp
      where fp.owner_id = ${ownerId}
        and fp.author_kind = 'member'
        and fp.contact_id is not null
        and fp.status <> 'pending'
    ),
    agg as (
      select
        m.contact_id,
        count(*)::int as post_count,
        max(m.created_at) as last_post_at,
        (count(*) filter (where m.is_unread))::int as unread
      from mine m
      group by m.contact_id
    ),
    newest as (
      select distinct on (m.contact_id) m.contact_id, m.body, m.topic_id
      from mine m
      order by m.contact_id, m.created_at desc
    )
    select
      a.contact_id,
      a.post_count,
      a.last_post_at,
      a.unread,
      n.body as last_post_body,
      ft.title as last_post_topic_title,
      (select count(*) from forum_topics t
        where t.owner_id = ${ownerId}
          and t.created_by_contact_id = a.contact_id)::int as topics_started
    from agg a
    left join newest n on n.contact_id = a.contact_id
    left join forum_topics ft on ft.id = n.topic_id
  `);
  // The driver returns either a bare array or {rows} — normalize like the
  // other raw-SQL call sites in this package (pages.ts, shares.ts).
  const rows = (
    Array.isArray(result) ? result : ((result as { rows?: Row[] }).rows ?? [])
  ) as Row[];

  return rows.map((r) => ({
    contactId: r.contact_id,
    postCount: r.post_count,
    topicsStarted: r.topics_started,
    lastPostAt: r.last_post_at ? new Date(r.last_post_at).toISOString() : null,
    lastPostBody: r.last_post_body,
    lastPostTopicTitle: r.last_post_topic_title,
    unread: r.unread,
  }));
}

export type ForumMemberPost = {
  id: string;
  body: string;
  createdAt: string;
  /** Set when this post filed a review/feature/bug request. */
  kind: ForumPostRequestKind | null;
  attachments: ConversationAttachment[];
  topicId: string;
  topicTitle: string;
  topicVisibility: ForumTopicVisibility;
  topicStatus: ForumTopicStatus;
  /** The agent's answer to THIS post, or null when the turn was waved off
   *  ("no answer needed") or is still owed. */
  reply: {
    id: string;
    body: string;
    authorName: string;
    traceId: string | null;
    status: 'pending' | 'complete' | 'failed';
    error: string | null;
    createdAt: string;
  } | null;
};

/**
 * One member's posts across every topic, newest first, each paired with the
 * agent answer that followed it — the person-first successor to reading their
 * Team Chat thread.
 *
 * "The answer that followed" is exact, not the next agent post in the topic:
 * the lateral requires no intervening member post, so in a busy multi-author
 * topic a member never gets credited with someone else's answer.
 */
export async function listForumPostsByContact(
  ownerId: string,
  contactId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<ForumMemberPost[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await db
    .select({
      id: forumPosts.id,
      body: forumPosts.body,
      createdAt: forumPosts.createdAt,
      kind: forumPosts.kind,
      attachments: forumPosts.attachments,
      topicId: forumTopics.id,
      topicTitle: forumTopics.title,
      topicVisibility: forumTopics.visibility,
      topicStatus: forumTopics.status,
      replyId: dsql<string | null>`reply.id`,
      replyBody: dsql<string | null>`reply.body`,
      replyAuthorName: dsql<string | null>`reply.author_name`,
      replyTraceId: dsql<string | null>`reply.trace_id`,
      replyStatus: dsql<string | null>`reply.status`,
      replyError: dsql<string | null>`reply.error`,
      replyCreatedAt: dsql<string | null>`reply.created_at`,
    })
    .from(forumPosts)
    .innerJoin(forumTopics, eq(forumTopics.id, forumPosts.topicId))
    .leftJoin(
      dsql`lateral (
        select p.id, p.body, p.author_name, p.trace_id, p.status, p.error, p.created_at
        from forum_posts p
        where p.topic_id = ${forumPosts.topicId}
          and p.author_kind = 'agent'
          and p.created_at > ${forumPosts.createdAt}
          and not exists (
            select 1 from forum_posts q
            where q.topic_id = ${forumPosts.topicId}
              and q.author_kind = 'member'
              and q.created_at > ${forumPosts.createdAt}
              and q.created_at < p.created_at
          )
        order by p.created_at asc
        limit 1
      ) reply`,
      dsql`true`,
    )
    .where(
      and(
        eq(forumPosts.ownerId, ownerId),
        eq(forumPosts.contactId, contactId),
        eq(forumPosts.authorKind, 'member'),
      ),
    )
    .orderBy(desc(forumPosts.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
    kind: r.kind,
    attachments: r.attachments,
    topicId: r.topicId,
    topicTitle: r.topicTitle,
    topicVisibility: r.topicVisibility,
    topicStatus: r.topicStatus,
    reply:
      r.replyId && r.replyCreatedAt
        ? {
            id: r.replyId,
            body: r.replyBody ?? '',
            authorName: r.replyAuthorName ?? 'Assistant',
            traceId: r.replyTraceId,
            status: (r.replyStatus ?? 'complete') as 'pending' | 'complete' | 'failed',
            error: r.replyError,
            createdAt: new Date(r.replyCreatedAt).toISOString(),
          }
        : null,
  }));
}

/** Total member posts by one contact — the pager's denominator. */
export async function countForumPostsByContact(
  ownerId: string,
  contactId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(forumPosts)
    .where(
      and(
        eq(forumPosts.ownerId, ownerId),
        eq(forumPosts.contactId, contactId),
        eq(forumPosts.authorKind, 'member'),
      ),
    );
  return row?.n ?? 0;
}

export type ForumAuthoredTopic = {
  id: string;
  title: string;
  kind: ForumTopicKind;
  visibility: ForumTopicVisibility;
  status: ForumTopicStatus;
  pinned: boolean;
  postCount: number;
  lastPostAt: string | null;
  createdAt: string;
};

/** Topics this member STARTED, newest first. Cheap — `forum_topics_author_idx`
 *  covers (owner_id, created_by_contact_id) exactly. */
export async function listForumTopicsByAuthor(
  ownerId: string,
  contactId: string,
  opts: { limit?: number } = {},
): Promise<ForumAuthoredTopic[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const rows = await db
    .select({
      id: forumTopics.id,
      title: forumTopics.title,
      kind: forumTopics.kind,
      visibility: forumTopics.visibility,
      status: forumTopics.status,
      pinned: forumTopics.pinned,
      postCount: forumTopics.postCount,
      lastPostAt: forumTopics.lastPostAt,
      createdAt: forumTopics.createdAt,
    })
    .from(forumTopics)
    .where(and(eq(forumTopics.ownerId, ownerId), eq(forumTopics.createdByContactId, contactId)))
    .orderBy(desc(forumTopics.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    lastPostAt: r.lastPostAt ? r.lastPostAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Mark a topic read for this viewer up to now. Upsert on the composite PK.
 *  Best-effort — a failed cursor write must never break a view. */
export async function markForumTopicRead(
  ownerId: string,
  viewer: ForumViewer,
  topicId: string,
): Promise<void> {
  await db
    .insert(forumReadCursors)
    .values({ ownerId, readerId: readerIdOf(ownerId, viewer), topicId, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [forumReadCursors.ownerId, forumReadCursors.readerId, forumReadCursors.topicId],
      set: { lastReadAt: new Date() },
    })
    .catch(() => {
      /* best-effort — the unread dot is a convenience, not a gate */
    });
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

/** Owner-only: pin/unpin (the announcement mechanism). True if a row changed. */
export async function setForumTopicPinned(
  ownerId: string,
  topicId: string,
  pinned: boolean,
): Promise<boolean> {
  const rows = await db
    .update(forumTopics)
    .set({ pinned, updatedAt: new Date() })
    .where(and(eq(forumTopics.id, topicId), eq(forumTopics.ownerId, ownerId)))
    .returning({ id: forumTopics.id });
  return rows.length > 0;
}

/** Flip a topic's lifecycle status. True if a row changed. */
export async function setForumTopicStatus(
  ownerId: string,
  topicId: string,
  status: ForumTopicStatus,
): Promise<boolean> {
  const rows = await db
    .update(forumTopics)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(forumTopics.id, topicId), eq(forumTopics.ownerId, ownerId)))
    .returning({ id: forumTopics.id });
  return rows.length > 0;
}
