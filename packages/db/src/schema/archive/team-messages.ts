/**
 * A team-portal contact's chat rows (no login) as they were when
 * team_messages folded into assistant_messages (migration 0269): history
 * only, never a thread. The member logins' rows went to
 * assistant_messages with the same ids. team_messages' columns (the types
 * and NOT NULLs, no foreign key, no check) plus archived_at. Read by no
 * product code. No grant to any role: the admin pool only.
 */
import { sql } from 'drizzle-orm';
import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const archiveTeamMessages = pgTable('archive_team_messages', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  contactId: uuid('contact_id'),
  direction: text('direction').notNull(),
  text: text('text').notNull(),
  agentId: uuid('agent_id'),
  model: text('model'),
  channel: text('channel').notNull(),
  attachments: jsonb('attachments')
    .default(sql`'[]'::jsonb`)
    .notNull(),
  traceId: uuid('trace_id'),
  status: text('status').notNull(),
  error: text('error'),
  loginId: uuid('login_id'),
  usedPrivate: boolean('used_private').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});
