import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents';

/**
 * Per-(owner, agent, login) read cursor for the assistant inbox (per login,
 * 0269: each user has their own thread with each assistant).
 * `last_read_at` marks how far that login has read its thread; unread =
 * outbound messages newer than this. One row per thread the login has ever
 * opened (absent → never read → everything counts as unread). See the mobile
 * companion's conversations inbox.
 */
export const assistantReadCursors = pgTable(
  'assistant_read_cursors',
  {
    ownerId: uuid('owner_id').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).defaultNow().notNull(),
    /** The login whose thread this is (0269). */
    loginId: uuid('login_id').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'assistant_read_cursors_owner_agent_login_pk',
      columns: [t.ownerId, t.agentId, t.loginId],
    }),
  ],
);

export type AssistantReadCursor = typeof assistantReadCursors.$inferSelect;
