/**
 * Forum · per-member views (the /team-admin Members tab).
 *
 * When the Forum replaced the 1:1 Team Chat, "what has this member been doing"
 * lost its home: chat froze, and forum activity is only reachable topic-first.
 * These queries restore the person-first view.
 *
 * They are OWNER-side only. There is NO visibility filter here, deliberately —
 * the owner sees every topic including `private` ones. Do NOT reuse them for a
 * member-facing surface without adding one.
 */
import { and, count, desc, eq, sql as dsql } from 'drizzle-orm';
import { db, forumPosts, forumTopics } from '@mantle/db';
import type {
  ForumAuthoredTopic,
  ForumMemberActivity,
  ForumMemberPost,
} from '@mantle/client-types';

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
