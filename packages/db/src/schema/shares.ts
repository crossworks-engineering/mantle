import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { nodes, nodeType } from './nodes';

/**
 * Read-only public share links. One row = one link. The `token` (a CSPRNG
 * value) is the URL; the public surface resolves a node strictly by an *active*
 * token (not revoked, not past `expires_at`) and never exposes `owner_id`.
 *
 * One active OPEN link per node is enforced by the partial unique index on
 * `node_id WHERE revoked_at IS NULL AND contact_id IS NULL` — toggling a
 * share off sets `revoked_at`, toggling on mints a fresh row. See
 * docs/sharing.md.
 *
 * A CONTACT share (migration 0214, `contact_id` set) is one item shared with
 * one contact: its own token, opened with that contact's code. One live
 * contact share per (node, contact). It never changes the item's level.
 * `can_write` (apps only) lets that contact write the app's data.
 */
export const shares = pgTable(
  'shares',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    token: text('token').notNull(),
    ownerId: uuid('owner_id').notNull(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    nodeType: nodeType('node_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    viewCount: integer('view_count').default(0).notNull(),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    settings: jsonb('settings')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    /** Set: a contact share for this contact node (migration 0214). */
    contactId: uuid('contact_id').references(() => nodes.id, { onDelete: 'cascade' }),
    /** A contact share of an app whose contact may write the app's data. */
    canWrite: boolean('can_write').default(false).notNull(),
  },
  (t) => [
    uniqueIndex('shares_token_uq').on(t.token),
    index('shares_owner_idx').on(t.ownerId),
    uniqueIndex('shares_node_open_uq')
      .on(t.nodeId)
      .where(sql`${t.revokedAt} is null and ${t.contactId} is null`),
    uniqueIndex('shares_node_contact_uq')
      .on(t.nodeId, t.contactId)
      .where(sql`${t.revokedAt} is null and ${t.contactId} is not null`),
    index('shares_contact_idx')
      .on(t.contactId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;
