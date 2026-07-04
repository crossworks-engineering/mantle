import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * Audit trail for the EXTERNAL app-share surface (/s/<token>/*). One row per
 * visitor action against a shared mini-app: a successful team-token auth, a
 * brokered tool call, or a brokered db statement.
 *
 * `contact_id` is the team member the visitor authenticated as — NULL means an
 * anonymous public-mode visitor. SET NULL (not cascade) on contact deletion:
 * the history of "something happened" outlives the person's contact record.
 * `share_id` is informational (shares are soft-revoked, rows persist).
 *
 * Owner-side broker calls (/api/apps/*) are deliberately NOT logged here —
 * this table answers "what did outsiders do", not "what did I do".
 */
export const appAccessLog = pgTable(
  'app_access_log',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    appNodeId: uuid('app_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    shareId: uuid('share_id'),
    contactId: uuid('contact_id').references(() => nodes.id, { onDelete: 'set null' }),
    /** 'auth' | 'tool' | 'db' */
    kind: text('kind').notNull(),
    /** e.g. { slug } for tool calls, { op } for db statements. */
    detail: jsonb('detail').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('app_access_log_app_idx').on(t.appNodeId, t.createdAt.desc()),
    index('app_access_log_owner_idx').on(t.ownerId),
    index('app_access_log_contact_idx').on(t.contactId),
  ],
);

export type AppAccessLogRow = typeof appAccessLog.$inferSelect;
