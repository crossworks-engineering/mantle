import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AppManifest, AppSource, BuildRef } from './apps';

/**
 * Snapshots and versions of an item, one timeline per node (apps first-class
 * plan, Phase 2; migration 0219). Apps now; tables later (`node_kind`).
 *
 * Two kinds of row on one numbered line (`seq`, what the owner sees as v1,
 * v2 …):
 *  - a VERSION (`trigger` 'publish'): written in the publish transaction,
 *    the code that went live (source, manifest, build). No data.
 *  - a SNAPSHOT (`manual`, or `pre_*` taken automatically before a risky
 *    change): the code AND a copy of the app's SQLite database, a file under
 *    APP_DB_DIR/_snapshots (`db_path`, relative to APP_DB_DIR).
 *
 * Append-only: a restore writes a new row (and the publish after it carries
 * `restored_from`); history is never rewritten. Rows outlive a deleted app
 * for 30 days (migration 0220), then the nightly purge removes them.
 */
export const nodeSnapshots = pgTable(
  'node_snapshots',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** The item's id. No foreign key since migration 0220: an app's history
     *  outlives the app for 30 days (the trash, app-trash.ts). */
    nodeId: uuid('node_id').notNull(),
    /** 'app' (tables later). */
    nodeKind: text('node_kind').notNull(),
    /** 1, 2, 3 … per node. */
    seq: integer('seq').notNull(),
    /** 'publish' | 'manual' | 'pre_restore' | 'pre_schema' | 'pre_delete'
     *  | 'pre_import' | 'nightly'. */
    trigger: text('trigger').notNull(),
    note: text('note'),
    /** 'owner' | 'agent' | 'mcp' | 'system'. */
    actor: text('actor').notNull(),
    /** The app's code at the time (null for a table). */
    code: jsonb('code').$type<AppSnapshotCode>(),
    /** sha256 of the canonical code JSON. */
    sourceHash: text('source_hash'),
    /** The database copy, relative to APP_DB_DIR; null for a version. */
    dbPath: text('db_path'),
    dbBytes: bigint('db_bytes', { mode: 'number' }),
    /** app_databases.schema_version when the copy was taken. */
    schemaVersion: integer('schema_version'),
    /** The seq this row's content was restored from, when it was. */
    restoredFrom: integer('restored_from'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('node_snapshots_node_seq_uq').on(t.nodeId, t.seq),
    index('node_snapshots_owner_idx').on(t.ownerId),
  ],
);

/** What an app snapshot or version keeps of the code. */
export type AppSnapshotCode = {
  /** The app's name and look when it was taken (what a deleted app comes
   *  back as). Absent on rows before Phase 3. */
  meta?: AppSnapshotMeta;
  source: AppSource;
  /** The unpublished draft at the time, when there was one. */
  draft: AppSource | null;
  manifest: AppManifest;
  publishedBuild: BuildRef | null;
};

export type AppSnapshotMeta = {
  title: string;
  icon?: string;
  color?: string;
  tags: string[];
};

export type NodeSnapshot = typeof nodeSnapshots.$inferSelect;
export type NewNodeSnapshot = typeof nodeSnapshots.$inferInsert;
