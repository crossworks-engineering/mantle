/**
 * Forum · read paths. The topic index and its count, one topic, a topic's
 * posts, in-topic post search, the turn-context tail, the daily-cap counter,
 * and the media-authorization probe.
 *
 * Every query here is visibility-enforced through `visibleTopicCond`, and
 * `getForumTopic` re-checks the pure `canViewTopic` predicate after the fetch:
 * the SQL is the belt, the predicate the suspenders, and the predicate is the
 * source of truth.
 */
import { and, asc, count, desc, eq, gte, ilike, lt, sql as dsql } from 'drizzle-orm';
import { db, forumPosts, forumTopics, type ForumPost, type ForumTopic } from '@mantle/db';
import { canViewTopic, type ForumViewer } from '../forum-visibility';
import { matchSnippet } from '../forum-search';
import type { ForumTopicListItem } from '@mantle/client-types';
import { readerIdOf, topicSearchCond, visibleTopicCond } from './shared';

/**
 * Topics holding a COMPLETE agent post that attached this file node.
 *
 * The authorization question for `/api/team/forum/media/<nodeId>`, and it is
 * deliberately asked of the POSTS and not of the file tree: "has the responder
 * ever touched this file" would hand a member the whole store, while "is it on
 * a post" is the same rule the forum already applies to an upload. Topic
 * visibility is then checked per candidate by the caller, so a node posted into
 * two topics is reachable through whichever one the member can actually see.
 *
 * `status = 'complete'` excludes a pending row mid-turn. Bounded because a node
 * on more than a handful of topics is pathological, not a use case.
 */
export async function forumTopicsWithAttachedNode(
  ownerId: string,
  nodeId: string,
): Promise<string[]> {
  const rows = await db
    .select({ topicId: forumPosts.topicId })
    .from(forumPosts)
    .where(
      and(
        eq(forumPosts.ownerId, ownerId),
        eq(forumPosts.status, 'complete'),
        dsql`${forumPosts.attachments} @> ${JSON.stringify([{ nodeId }])}::jsonb`,
      ),
    )
    .limit(20);
  return [...new Set(rows.map((r) => r.topicId))];
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
