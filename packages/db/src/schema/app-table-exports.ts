import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * App table exports — a brain Table kept as a DERIVED, read-only view of one
 * table inside an app's own SQLite database. The APP is the master: after an
 * app write the platform re-materializes the Table from the SQLite rows (pure
 * SQL, no LLM), so the assistant, table views and shares see live app data
 * without the app holding any table-write capability.
 *
 * While a link row exists the Table refuses every grid edit from the Tables
 * side (rows, cells, columns, tabs, delete) — data changes only in the app.
 * Metadata (title/tags/icon/visibility) stays owner-editable. `content_hash`
 * short-circuits a re-materialize whose rows didn't change, so a chatty app
 * can't turn the debounced sync into commit/extractor churn.
 *
 * Both FKs cascade: deleting the app OR the table dissolves the link (a
 * table orphaned by app deletion becomes an ordinary editable table).
 * See packages/content/src/app-table-exports.ts.
 */
export const appTableExports = pgTable(
  'app_table_exports',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    appNodeId: uuid('app_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    sqliteTable: text('sqlite_table').notNull(),
    tableNodeId: uuid('table_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** Set by the first app write a sync has not read yet; cleared by the
     *  sync that reads it (migration 0221, apps plan D8). The boot and the
     *  app-export-catch-up maintenance task (by hand, never the nightly
     *  cron: a sync commits) sync what a restart left dirty. */
    dirtySince: timestamp('dirty_since', { withTimezone: true }),
    /** Every app write's time (migration 0223, apps audit 2026-10-02 item
     *  7): a sync clears `dirtySince` only when no write came after it read
     *  the rows. */
    lastWriteAt: timestamp('last_write_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('app_table_exports_table_uq').on(t.tableNodeId),
    uniqueIndex('app_table_exports_app_table_uq').on(t.appNodeId, t.sqliteTable),
    index('app_table_exports_owner_idx').on(t.ownerId),
    index('app_table_exports_dirty_idx')
      .on(t.dirtySince)
      .where(sql`${t.dirtySince} IS NOT NULL`),
  ],
);

export type AppTableExport = typeof appTableExports.$inferSelect;
export type NewAppTableExport = typeof appTableExports.$inferInsert;
