/**
 * The records migration 0274 (workspaces W8d) keeps of the frozen chat and
 * client tables it drops: the owner's read cursors of the old portal
 * threads, the member notifications, a login's own chat read cursor, the
 * "what clients see" acknowledgements and the client quota log, each as it
 * was (every column, plus archived_at). team_messages itself is not
 * archived again: its rows are in assistant_messages and
 * archive_team_messages (0269), which 0274 proves before the drop. Read by
 * no product code. No grant to any role: the admin pool only
 * (access-matrix.ts).
 */
import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const archiveTeamReadCursors = pgTable(
  'archive_team_read_cursors',
  {
    ownerId: uuid('owner_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.contactId] })],
);

export const archiveTeamNotifications = pgTable('archive_team_notifications', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  threadId: uuid('thread_id').notNull(),
  recipientId: uuid('recipient_id').notNull(),
  senderId: uuid('sender_id').notNull(),
  senderName: text('sender_name'),
  body: text('body').notNull(),
  topicId: uuid('topic_id'),
  postId: uuid('post_id'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archiveLoginChatReadCursors = pgTable('archive_login_chat_read_cursors', {
  loginId: uuid('login_id').primaryKey(),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archiveClientReportAcks = pgTable('archive_client_report_acks', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  ackedBy: uuid('acked_by'),
  ackedAt: timestamp('acked_at', { withTimezone: true }).notNull(),
  itemIds: uuid('item_ids').array().notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archiveClientQuotaRefusals = pgTable('archive_client_quota_refusals', {
  id: uuid('id').primaryKey(),
  loginId: uuid('login_id'),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});
