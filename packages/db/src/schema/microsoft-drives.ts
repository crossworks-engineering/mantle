import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';
import { msAccounts } from './microsoft';

/**
 * M1 — SharePoint / OneDrive sync.
 *
 * A `ms_drives` row is a drive (an OneDrive, or a SharePoint document library)
 * the connected account can see. Discovery upserts them disabled; the user
 * opts specific drives in (mirrors the email contact-gate's "ingest nothing
 * until chosen"). The Graph delta cursor for incremental sync lives here per
 * drive (`delta_link`) rather than in `ms_accounts.sync_state`, so each drive
 * tracks + surfaces its own state.
 *
 * Synced files are ordinary `type: 'file'` nodes (so the existing extractor
 * parses/embeds them unchanged); `ms_drive_items` is the provenance + dedup map
 * from a Graph driveItem to its node.
 */
export const msDrives = pgTable(
  'ms_drives',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => msAccounts.id, { onDelete: 'cascade' }),
    /** Graph drive id. */
    driveId: text('drive_id').notNull(),
    /** `personal` (OneDrive) | `documentLibrary` (SharePoint) | other Graph driveType. */
    driveType: text('drive_type').notNull(),
    name: text('name').notNull(),
    /** SharePoint site display name; null for OneDrive. */
    siteName: text('site_name'),
    webUrl: text('web_url'),
    /** ltree label this drive's files land under, beneath the account branch. */
    branchLabel: text('branch_label').notNull(),
    /** Opt-in: nothing syncs until enabled. */
    enabled: boolean('enabled').default(false).notNull(),
    /** Graph `@odata.deltaLink` cursor; null = do a full initial enumeration. */
    deltaLink: text('delta_link'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('ms_drives_account_idx').on(t.accountId),
    uniqueIndex('ms_drives_account_drive_uq').on(t.accountId, t.driveId),
  ],
);

export const msDriveItems = pgTable(
  'ms_drive_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => msAccounts.id, { onDelete: 'cascade' }),
    driveDbId: uuid('drive_db_id')
      .notNull()
      .references(() => msDrives.id, { onDelete: 'cascade' }),
    /** The deduped `file` node these bytes live in (shared if the same sha256
     *  already arrived via another source). `restrict` so a node can't vanish
     *  out from under a live mapping. */
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    /** Graph driveItem id — stable within a drive; the dedup key for "seen". */
    itemId: text('item_id').notNull(),
    /** Graph eTag — a cheap "did this change" check across syncs. */
    etag: text('etag'),
    webUrl: text('web_url'),
    /** ltree path we placed the node at (kept for cleanup on delete). */
    nodePath: text('node_path'),
    lastModified: timestamp('last_modified', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('ms_drive_items_drive_idx').on(t.driveDbId),
    index('ms_drive_items_node_idx').on(t.nodeId),
    uniqueIndex('ms_drive_items_drive_item_uq').on(t.driveDbId, t.itemId),
  ],
);

/**
 * Optional per-drive sync scope — the "choose what to sync" selections. No
 * rows = the whole drive syncs (the v1 behaviour, unchanged). Rows = only
 * files under a selected folder (prefix match on the after-`root:` path) or
 * exactly-selected files sync; previously-ingested files that fall outside
 * are pruned on the next full walk. Saving a scope set clears the drive's
 * `delta_link` so that walk happens on the next sync.
 */
export const msDriveScopes = pgTable(
  'ms_drive_scopes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    driveDbId: uuid('drive_db_id')
      .notNull()
      .references(() => msDrives.id, { onDelete: 'cascade' }),
    /** Graph driveItem id of the selected folder/file. */
    itemId: text('item_id').notNull(),
    /** Item path after `root:`, always starting with `/` (e.g. `/Reports/2026`). */
    path: text('path').notNull(),
    isFolder: boolean('is_folder').notNull(),
    /** Display name at selection time (paths drift on rename; this is UI-only). */
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('ms_drive_scopes_drive_item_uq').on(t.driveDbId, t.itemId)],
);

export type MsDrive = typeof msDrives.$inferSelect;
export type NewMsDrive = typeof msDrives.$inferInsert;
export type MsDriveItem = typeof msDriveItems.$inferSelect;
export type NewMsDriveItem = typeof msDriveItems.$inferInsert;
export type MsDriveScope = typeof msDriveScopes.$inferSelect;
export type NewMsDriveScope = typeof msDriveScopes.$inferInsert;
