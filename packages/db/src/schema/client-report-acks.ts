import { index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * "What clients see" acknowledgements (client logins C1, migration 0187).
 * Before the first client login on a box, an admin reads the list of every
 * item set to client and acknowledges it. One row per acknowledgement, the
 * newest wins: it records who, when, and the ids of the client-level items
 * the admin saw. When an item not in that list is at client level later,
 * the report asks again. Adding a client stays disabled until then (C2).
 *
 * `acked_by` FKs auth.users ON DELETE SET NULL in the SQL. Admin only: no
 * viewer role reads it.
 */
export const clientReportAcks = pgTable(
  'client_report_acks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    ackedBy: uuid('acked_by'),
    ackedAt: timestamp('acked_at', { withTimezone: true }).defaultNow().notNull(),
    itemIds: uuid('item_ids').array().notNull(),
  },
  (t) => [index('client_report_acks_owner_idx').on(t.ownerId, t.ackedAt)],
);

export type ClientReportAckRow = typeof clientReportAcks.$inferSelect;
