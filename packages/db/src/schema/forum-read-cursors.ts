import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Per-reader unread cursors for the Team Forum — unlike Team Chat (where only
 * the OWNER tracked unread), every forum reader gets one cursor per topic.
 * `reader_id` is the member's contact id, or the owner's id for the owner's
 * own cursor — which is why there is no FK (the owner is not a node). A
 * deleted contact's cursors are inert junk swept when its topics go; the
 * unread queries only ever join cursors for live token holders.
 */
export const forumReadCursors = pgTable(
  'forum_read_cursors',
  {
    ownerId: uuid('owner_id').notNull(),
    /** Contact node id for members; owner_id for the owner's cursor. */
    readerId: uuid('reader_id').notNull(),
    topicId: uuid('topic_id').notNull(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.readerId, t.topicId] })],
);

export type ForumReadCursor = typeof forumReadCursors.$inferSelect;
