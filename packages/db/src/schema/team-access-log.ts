import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * Audit trail for the EXTERNAL Team Chat surface (/team + /api/team/*). One
 * row per member action: a successful team-token auth, a chat turn, a bearer
 * API call, or a denied attempt (rate limit / revoked membership).
 *
 * The `app_access_log` pattern minus the app FK — Team Chat is brain-level,
 * not share-scoped. SET NULL (not cascade) on contact deletion: the history of
 * "something happened" outlives the person's contact record, even though their
 * thread (team_messages) cascades away with them.
 */
export const teamAccessLog = pgTable(
  'team_access_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    contactId: uuid('contact_id').references(() => nodes.id, { onDelete: 'set null' }),
    /** 'auth' | 'turn' | 'api' | 'denied' */
    kind: text('kind').notNull(),
    /** e.g. { channel } for turns, { reason } for denials. */
    detail: jsonb('detail')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('team_access_log_recent_idx').on(t.ownerId, t.createdAt.desc()),
    index('team_access_log_contact_idx').on(t.ownerId, t.contactId, t.createdAt.desc()),
  ],
);

export type TeamAccessLogRow = typeof teamAccessLog.$inferSelect;
