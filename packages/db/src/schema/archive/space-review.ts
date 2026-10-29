/**
 * The review tables as they were when the review flows went (migration
 * 0264): every row of space_items, space_submissions and
 * space_item_bundles, copied before the states resolved and the submission
 * and bundle rows were cleared. Each table has its source's columns (the
 * types and NOT NULLs, no foreign key, no check) plus archived_at; the
 * test pins the columns against the source table. Read by no
 * product code; mantle_ws_review_off() reads the item states from here when
 * it records homes. No grant to any role: definer functions and the admin
 * pool only.
 */
import { integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const archiveSpaceItems = pgTable('archive_space_items', {
  nodeId: uuid('node_id').primaryKey(),
  authorLoginId: uuid('author_login_id'),
  sharing: text('sharing').notNull(),
  reviewState: text('review_state').notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedVersion: integer('submitted_version'),
  returnedNote: text('returned_note'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  takenBy: uuid('taken_by'),
  takenAt: timestamp('taken_at', { withTimezone: true }),
  takenRoot: uuid('taken_root'),
  authorRole: text('author_role'),
  takenTitle: text('taken_title'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archiveSpaceSubmissions = pgTable('archive_space_submissions', {
  id: uuid('id').primaryKey(),
  spaceId: uuid('space_id').notNull(),
  nodeId: uuid('node_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archiveSpaceItemBundles = pgTable(
  'archive_space_item_bundles',
  {
    rootId: uuid('root_id').notNull(),
    nodeId: uuid('node_id').notNull(),
    position: integer('position').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.rootId, t.nodeId] })],
);

/** Every personal space row as it was when the spaces folded into the brain
 *  (migration 0267). The spaces rows stay (a kind root still names its
 *  space); this is the record. */
export const archiveSpaces = pgTable('archive_spaces', {
  id: uuid('id').primaryKey(),
  kind: text('kind').notNull(),
  loginId: uuid('login_id'),
  orphanedAt: timestamp('orphaned_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});
