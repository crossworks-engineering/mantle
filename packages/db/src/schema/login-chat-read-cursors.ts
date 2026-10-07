import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * How far a member or a client login has read its OWN chat thread
 * (team_messages by login, mobile_roles_push). Unread = finished outbound rows newer than
 * `last_read_at`. One row per login, made by the login's first unread read
 * (so a login starts with nothing unread). `team_read_cursors` is the admin
 * side, keyed by contact. The `login_id` FK into `auth.users` is declared in
 * the SQL migration (cross-schema, cascade).
 */
export const loginChatReadCursors = pgTable('login_chat_read_cursors', {
  loginId: uuid('login_id').primaryKey(),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }).defaultNow().notNull(),
});

export type LoginChatReadCursor = typeof loginChatReadCursors.$inferSelect;
