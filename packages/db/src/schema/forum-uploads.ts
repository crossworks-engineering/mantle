import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { forumPosts } from './forum-posts';
import { forumTopics } from './forum-topics';
import { nodes } from './nodes';

/** Review lifecycle of a member's forum upload. `staged` = bytes in quarantine,
 *  no post yet (the composer uploaded ahead of posting). `pending` = bound to a
 *  post, awaiting owner review. `filed` = owner moved it into the files tree
 *  (`node_id` set; ingestion ran). `dismissed` = owner dropped it (bytes gone,
 *  the row stays as the audit record). */
export type ForumUploadStatus = 'staged' | 'pending' | 'filed' | 'dismissed';

/**
 * Member file uploads on forum posts — the quarantine review queue.
 *
 * Bytes live OUTSIDE the files ltree (quarantine dir, see @mantle/files
 * quarantine helpers), so nothing ingests until the owner files it. The post's
 * immutable `attachments` jsonb references blobs by `fileId`; THIS row is the
 * mutable review state — clients join the two on id.
 *
 * `topic_id` is nullable while `staged` (the new-topic dialog uploads before
 * its topic exists); binding sets `topic_id` + `post_id` together in the post's
 * own transaction. `contact_id` goes SET NULL on contact deletion — same rule
 * as forum_posts, uploads are team knowledge and outlive their author.
 */
export const forumUploads = pgTable(
  'forum_uploads',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    topicId: uuid('topic_id').references(() => forumTopics.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').references(() => forumPosts.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => nodes.id, { onDelete: 'set null' }),
    /** Sanitized display filename (sanitizeFilename ran at stage time). */
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status').$type<ForumUploadStatus>().default('staged').notNull(),
    /** The file node created when the owner filed this into the files tree. */
    nodeId: uuid('node_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (t) => [
    // Admin review queue (pending per owner) + badge count.
    index('forum_uploads_owner_status_idx').on(t.ownerId, t.status),
    // Post → its blobs.
    index('forum_uploads_post_idx').on(t.postId),
    // Per-contact daily byte budget window.
    index('forum_uploads_contact_created_idx').on(t.ownerId, t.contactId, t.createdAt),
  ],
);

export type ForumUpload = typeof forumUploads.$inferSelect;
export type NewForumUpload = typeof forumUploads.$inferInsert;
