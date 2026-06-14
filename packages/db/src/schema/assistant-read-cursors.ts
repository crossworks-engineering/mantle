import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents';

/**
 * Per-(owner, agent) read cursor for the assistant inbox. `last_read_at` marks
 * how far the operator has read that agent's forever-thread; unread = outbound
 * messages newer than this. One row per agent the operator has ever opened
 * (absent → never read → everything counts as unread). See the mobile
 * companion's conversations inbox.
 */
export const assistantReadCursors = pgTable(
  'assistant_read_cursors',
  {
    ownerId: uuid('owner_id').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.agentId] })],
);

export type AssistantReadCursor = typeof assistantReadCursors.$inferSelect;
