import { sql } from 'drizzle-orm';
import { bigint, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * The Sync service's file map (migration 0382; Sync service plan M3): one row
 * per file a drive sync placed in the brain, from the outside item (service,
 * source = the drive, item id) to its file node. `hash` is the provider's
 * hash from the listing (OneDrive's QuickXorHash), so an unchanged item is
 * never fetched again. The row goes with its node (CASCADE). Read and written
 * only by the sidecar routes, on the system pool (sync-items.ts).
 */
export const syncItems = pgTable(
  'sync_items',
  {
    service: text('service').notNull(),
    source: text('source').notNull(),
    itemId: text('item_id').notNull(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    hash: text('hash'),
    size: bigint('size', { mode: 'number' }),
    modTime: timestamp('mod_time', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.service, t.source, t.itemId] }),
    index('sync_items_node_idx').on(t.nodeId),
  ],
);

export type SyncItemRow = typeof syncItems.$inferSelect;
