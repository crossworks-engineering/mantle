import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/** What a topic is for. `question` (default) and `discussion` stay in the
 *  forum; `review` | `feature` | `bug` are the request flags — creating a
 *  topic (or post) so flagged deterministically files an owner review task
 *  (Phase 2). `discussion` never summons the agent by default and never
 *  files a request. */
export type ForumTopicKind = 'question' | 'review' | 'feature' | 'bug' | 'discussion';

/** `team` topics are visible to every member AND become brain corpus
 *  (Phase 3). `private` topics are visible to their author + the owner only
 *  and are NEVER ingested — brain reads are team-wide, so indexing a private
 *  topic would leak it through retrieval. */
export type ForumTopicVisibility = 'team' | 'private';

export type ForumTopicStatus = 'open' | 'answered' | 'closed';

/**
 * Team Forum topics — the shared successor to the per-contact Team Chat
 * forever-thread. A topic is a titled, multi-author thread every team member
 * can read (visibility `team`); posts live in `forum_posts`.
 *
 * `created_by_contact_id` goes SET NULL on contact deletion (with
 * `author_name` as the durable snapshot): forum content is team knowledge and
 * outlives its author — deliberately UNLIKE `team_messages`, where the 1:1
 * thread cascades with the person. NULL author + NULL contact ⇒ owner-created.
 *
 * `pinned` is owner-only and floats a topic to the top of the list — the
 * announcement mechanism (no dedicated kind). `node_id` will point at the
 * topic's shadow `forum_topic` node once brain ingestion lands (Phase 3).
 */
export const forumTopics = pgTable(
  'forum_topics',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    title: text('title').notNull(),
    kind: text('kind').$type<ForumTopicKind>().default('question').notNull(),
    visibility: text('visibility').$type<ForumTopicVisibility>().default('team').notNull(),
    pinned: boolean('pinned').default(false).notNull(),
    status: text('status').$type<ForumTopicStatus>().default('open').notNull(),
    createdByContactId: uuid('created_by_contact_id').references(() => nodes.id, {
      onDelete: 'set null',
    }),
    /** Display-name snapshot taken at creation — survives contact deletion. */
    authorName: text('author_name').notNull(),
    /** Shadow node for brain ingestion (Phase 3); no FK — the node is derived
     *  and reconciled by the extractor side, never a referential parent. */
    nodeId: uuid('node_id'),
    /** Denormalized for the topic list — maintained by appendForumPost. */
    postCount: integer('post_count').default(0).notNull(),
    lastPostAt: timestamp('last_post_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Drives the topic list: pinned first, then latest activity.
    index('forum_topics_list_idx').on(t.ownerId, t.pinned.desc(), t.lastPostAt.desc()),
    // Private-topic scoping for a member's own list.
    index('forum_topics_author_idx').on(t.ownerId, t.createdByContactId),
  ],
);

export type ForumTopic = typeof forumTopics.$inferSelect;
export type NewForumTopic = typeof forumTopics.$inferInsert;
