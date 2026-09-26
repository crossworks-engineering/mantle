import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
 */
export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    kind: text('kind').$type<SpaceKind>().notNull(),
    loginId: uuid('login_id').references(() => authUsers.id, { onDelete: 'set null' }),
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

export const REVIEW_STATES = ['draft', 'submitted', 'returned', 'accepted'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/**
 * Sharing and review state of a personal item (plan 2d). One row per item in
 * a personal space, written by the space-items state function only.
 *
 * draft -> submitted -> accepted (moved into the brain) | returned (back to
 * the author with a note); submitted -> draft by Recall (the author, before
 * Accept). A submitted item is FROZEN: the row rules refuse every write to it
 * until Accept, Return or Recall.
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
  ],
);

export type Space = typeof spaces.$inferSelect;
export type SpaceItem = typeof spaceItems.$inferSelect;
