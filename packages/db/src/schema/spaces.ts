import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users';
import { nodes } from './nodes';

export const SPACE_KINDS = ['brain', 'personal'] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

/**
 * What `nodes.owner_id` points at (member logins Phase 2, migration 0165).
 *
 * - `brain`: one row per box, id = the anchor login's id, so every brain row
 *   kept its owner_id. Every brain path filters on it.
 * - `personal`: one per login (admins too), made with the login by a trigger
 *   on auth.users. Items here are never indexed, extracted or learned: the
 *   brain's filters never match them, the ingest trigger skips them, and the
 *   extractor gate checks the owner.
 *
 * `login_id` goes null on a hard login delete; nothing cascades into items.
 * `orphaned_at` records when (a trigger, migration 0180): the purge treats an
 * orphaned space like a deactivated login's, 30 days on.
 */
export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    kind: text('kind').$type<SpaceKind>().notNull(),
    loginId: uuid('login_id').references(() => authUsers.id, { onDelete: 'set null' }),
    orphanedAt: timestamp('orphaned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('spaces_personal_login_uq')
      .on(t.loginId)
      .where(sql`${t.kind} = 'personal'`),
  ],
);

export const SPACE_SHARING = ['private', 'team'] as const;
export type SpaceSharing = (typeof SPACE_SHARING)[number];

export const REVIEW_STATES = ['draft', 'submitted', 'returned', 'accepted', 'taken'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/**
 * Sharing and review state of a personal item (plan 2d). One row per item in
 * a personal space, written by the space-items state function only.
 *
 * draft -> submitted -> accepted (moved into the brain) | returned (back to
 * the author with a note); submitted -> draft by Recall (the author, before
 * Accept). A submitted item is FROZEN: the row rules refuse every write to it
 * until Accept, Return or Recall.
 *
 * submitted -> taken (audit F07, migration 0183): an admin took the item
 * (and its bundle) into their own private space to work on it. The row
 * stays and still names the author; `taken_by` is the admin, `taken_root`
 * the item it was taken with (NULL on the root itself). taken -> accepted
 * (the admin accepts it) or returned (the admin gives it back).
 */
export const spaceItems = pgTable(
  'space_items',
  {
    nodeId: uuid('node_id')
      .primaryKey()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    authorLoginId: uuid('author_login_id').references(() => authUsers.id, {
      onDelete: 'set null',
    }),
    sharing: text('sharing').$type<SpaceSharing>().notNull().default('private'),
    reviewState: text('review_state').$type<ReviewState>().notNull().default('draft'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submittedVersion: integer('submitted_version'),
    returnedNote: text('returned_note'),
    reviewedBy: uuid('reviewed_by').references(() => authUsers.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    takenBy: uuid('taken_by').references(() => authUsers.id, { onDelete: 'set null' }),
    takenAt: timestamp('taken_at', { withTimezone: true }),
    /** The root this item was taken with (its bundle); NULL on the root. */
    takenRoot: uuid('taken_root'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('space_items_team_idx')
      .on(t.nodeId)
      .where(sql`${t.sharing} = 'team'`),
    index('space_items_submitted_idx')
      .on(t.submittedAt)
      .where(sql`${t.reviewState} = 'submitted'`),
    index('space_items_author_idx').on(t.authorLoginId),
    index('space_items_taken_idx')
      .on(t.takenBy)
      .where(sql`${t.reviewState} = 'taken'`),
    index('space_items_taken_root_idx')
      .on(t.takenRoot)
      .where(sql`${t.takenRoot} is not null`),
  ],
);

/**
 * The bundle a submitted item was submitted with (migration 0180, audit F04):
 * the item itself and everything that renders inside it, recorded at Submit.
 * While the root is submitted every item here is frozen too (the row rules'
 * `mantle_space_item_frozen`), and Accept moves exactly these items. Recall,
 * Return and Accept remove the rows. The space role writes its own space's
 * bundles, only while the root is not submitted.
 */
export const spaceItemBundles = pgTable(
  'space_item_bundles',
  {
    rootId: uuid('root_id')
      .notNull()
      .references(() => spaceItems.nodeId, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    /** Bundle order: the root first, a parent page before its children. */
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.rootId, t.nodeId] }),
    index('space_item_bundles_node_idx').on(t.nodeId),
  ],
);

/**
 * The upload ledger of a personal space (migration 0169, audit D3): one row
 * per member upload, kept when the file is deleted, so the daily upload cap
 * counts what was uploaded, not what is still there. The space role inserts
 * and reads its own rows; nothing below admin updates or deletes them.
 */
export const spaceUploads = pgTable(
  'space_uploads',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('space_uploads_space_time_idx').on(t.spaceId, t.createdAt)],
);

/**
 * The accepted SAVED version of a member-authored item, for its author
 * (audit F07, migration 0183). Written at every Accept of a member's item;
 * what /api/member/accepted serves, never the brain's current version. A
 * table's workbook is a copy under TABLE_DB_DIR (`table_path`); a file keeps
 * its sha256 only. `pending`: a pre-0183 table or file the migration could
 * not copy in SQL, completed on the author's first read. Admin pool only.
 */
export const acceptedSnapshots = pgTable('accepted_snapshots', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  icon: text('icon'),
  version: integer('version'),
  doc: jsonb('doc'),
  content: text('content'),
  scene: jsonb('scene'),
  sceneSvg: text('scene_svg'),
  fileRefs: jsonb('file_refs'),
  tablePath: text('table_path'),
  tableDoc: jsonb('table_doc'),
  fileSha256: text('file_sha256'),
  fileName: text('file_name'),
  fileMime: text('file_mime'),
  fileSize: bigint('file_size', { mode: 'number' }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).defaultNow().notNull(),
  pending: boolean('pending').default(false).notNull(),
});

export type Space = typeof spaces.$inferSelect;
export type SpaceItem = typeof spaceItems.$inferSelect;
