import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * Per-app SQLite registry. Each app gets ONE durable SQLite database; the host
 * broker opens only the file named here for the matching app, so a sandboxed
 * app can never reach another app's data (there's no path input — only the
 * authenticated app node id). Cascades when the app node is deleted.
 *
 * `storage_path` is a server-local volume path (MVP); `schema_version` tracks
 * how far the app's declared DDL (manifest.sqlite.schemaSql) has been applied.
 * See packages/content/src/app-broker.ts.
 */
export const appDatabases = pgTable(
  'app_databases',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    appNodeId: uuid('app_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    storagePath: text('storage_path').notNull(),
    schemaVersion: integer('schema_version').default(0).notNull(),
    sizeBytes: integer('size_bytes').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('app_databases_app_uq').on(t.appNodeId),
    index('app_databases_owner_idx').on(t.ownerId),
  ],
);

export type AppDatabase = typeof appDatabases.$inferSelect;
export type NewAppDatabase = typeof appDatabases.$inferInsert;
