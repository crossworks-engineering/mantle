import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { forumTopics } from './forum-topics';
import { nodes } from './nodes';
import type { ConversationAttachment } from './assistant-messages';
import type { TeamChannel } from './team-messages';

export type ForumPostAuthorKind = 'member' | 'owner' | 'agent';

/** Request flag a post filed (Phase 2) — a subset of ForumTopicKind: only the
 *  kinds that create an owner review task. */
export type ForumPostRequestKind = 'review' | 'feature' | 'bug';

/**
 * Posts inside a Team Forum topic — flat, chronological, multi-author.
 * `author_kind` distinguishes the three voices: `member` (a contact holding a
 * team token), `owner` (the brain admin, incl. replies delivered from a review
 * — those carry `source_request_task_id`), and `agent` (the team responder;
 * `agent_id`/`model`/`trace_id` mirror `team_messages` so the admin can
 * deep-link the turn's tool-call record).
 *
 * `contact_id` goes SET NULL on contact deletion with `author_name` as the
 * durable snapshot — posts are team knowledge and outlive their author (see
 * forum_topics header). `status` 'pending' is the durable "thinking…" bubble
 * for agent posts, finalized by the turn pipeline exactly like team_messages.
 */
export const forumPosts = pgTable(
  'forum_posts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => forumTopics.id, { onDelete: 'cascade' }),
    authorKind: text('author_kind').$type<ForumPostAuthorKind>().notNull(),
    contactId: uuid('contact_id').references(() => nodes.id, { onDelete: 'set null' }),
    /** Display-name snapshot at post time ('the owner's name' / agent name). */
    authorName: text('author_name').notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    model: text('model'),
    traceId: uuid('trace_id'),
    body: text('body').notNull(),
    /** Same shape as assistant_messages/team_messages attachments — Phase 4
     *  wires uploads; the column exists from day one so no migration then. */
    attachments: jsonb('attachments')
      .$type<ConversationAttachment[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    /** Set when this post filed a review/feature/bug request (Phase 2). The
     *  task side carries the back-link in data.teamRequest.{topicId,postId}. */
    kind: text('kind').$type<ForumPostRequestKind>(),
    /** Set on owner posts delivered from the review queue — the task whose
     *  resolution this post is. */
    sourceRequestTaskId: uuid('source_request_task_id'),
    channel: text('channel').$type<TeamChannel>().default('web').notNull(),
    status: text('status').$type<'pending' | 'complete' | 'failed'>().default('complete').notNull(),
    error: text('error'),
    /** DBOS forum-turn workflow that created an AGENT pending post. Lets a
     *  recovery replay adopt its own prior pending row (by topic+workflow_id)
     *  instead of conflicting with the one-pending-per-topic unique index.
     *  Null on member/owner posts. */
    workflowId: text('workflow_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (t) => [
    // Drives the topic transcript (member view + turn context loader).
    index('forum_posts_topic_idx').on(t.topicId, t.createdAt),
    // Drives "recent forum activity" (admin) and the member daily-cap count.
    index('forum_posts_recent_idx').on(t.ownerId, t.createdAt.desc()),
    // Backstop invariant (the partitioned FORUM_QUEUE is the primary serializer
    // now): at most one in-flight pending agent post per topic. A replay adopts
    // its own row via workflow_id rather than tripping this.
    uniqueIndex('forum_posts_one_pending_agent_idx')
      .on(t.topicId)
      .where(sql`${t.authorKind} = 'agent' AND ${t.status} = 'pending'`),
    // Adopt-own-pending lookup for replay idempotency.
    index('forum_posts_workflow_idx')
      .on(t.topicId, t.workflowId)
      .where(sql`${t.authorKind} = 'agent' AND ${t.status} = 'pending'`),
  ],
);

export type ForumPost = typeof forumPosts.$inferSelect;
export type NewForumPost = typeof forumPosts.$inferInsert;
