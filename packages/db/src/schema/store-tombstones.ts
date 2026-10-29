import { sql } from 'drizzle-orm';
import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The snapshot store's tombstones (migration 0284; docs/store-brokers.md): a file a deleted or re-pointed row named (a
 * snapshot's database copy, an accepted table's workbook copy), recorded by
 * a trigger in the row's own transaction. The one store sweep removes the
 * file a grace period later, while no row names it, then the tombstone.
 * The system pool's only (row level security on, no policy, no grant).
 */
export const storeTombstones = pgTable(
  'store_tombstones',
  {
    /** 'appsnap' (path relative to APP_DB_DIR), 'tablesnap' and 'accepted'
     *  (relative to TABLE_DB_DIR). */
    store: text('store').notNull(),
    path: text('path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.store, t.path] })],
);
