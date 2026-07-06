import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * Admin unread cursor for Team Chat: when the owner last read a given member's
 * thread in /team-admin. Unread badge = that member's inbound messages created
 * after `last_read_at`. Composite PK (owner, contact) — one cursor per member.
 * contact_id CASCADEs with the contact, matching team_messages.
 */
export const teamReadCursors = pgTable(
  'team_read_cursors',
  {
    ownerId: uuid('owner_id').notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.contactId] })],
);

export type TeamReadCursor = typeof teamReadCursors.$inferSelect;
