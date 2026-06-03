import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * A collection of markdown docs synced from disk into the brain as
 * `type='documentation'` nodes. The opt-in unit for the documentation feature:
 * the docs-sync worker only reconciles + watches ENABLED collections, and the
 * `system` collection (the repo's own docs/) ships disabled — nothing indexes
 * until the owner flips it on at /settings/documentation.
 *
 * `brainDepth` controls how deep the collection's docs go into memory:
 *   'retrieval' — L5 only (summary + embedding + heading-chunks); the Docs agent
 *                 finds & cites, but no facts/entities/graph land in the personal
 *                 profile. Default for system docs (keeps system-meta out of the
 *                 life-tree).
 *   'full'      — the complete extractor pipeline (facts/entities/graph too), for
 *                 user-authored doc collections later.
 */
export const docCollections = pgTable(
  'doc_collections',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** Stable slug, unique per owner (e.g. 'system'). */
    key: text('key').notNull(),
    /** Human label shown in /settings/documentation (e.g. 'System docs'). */
    label: text('label').notNull(),
    /** 'system' (repo docs) | 'user' (user-authored docs). */
    origin: text('origin').notNull().default('system'),
    /** Absolute (or repo-relative) disk root; null ⇒ MANTLE_DOCS_ROOT for 'system'. */
    rootPath: text('root_path'),
    /** 'retrieval' (L5 only) | 'full' (full extractor pipeline). */
    brainDepth: text('brain_depth').notNull().default('retrieval'),
    /** Off by default — indexing is opt-in. */
    enabled: boolean('enabled').notNull().default(false),
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('doc_collections_owner_key_uq').on(t.ownerId, t.key)],
);

export type DocCollection = typeof docCollections.$inferSelect;
export type NewDocCollection = typeof docCollections.$inferInsert;
export type DocBrainDepth = 'retrieval' | 'full';
