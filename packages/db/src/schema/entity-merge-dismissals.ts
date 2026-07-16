import { sql } from 'drizzle-orm';
import { pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Persisted "not a duplicate" decisions for the entity-merge review surface.
 * Candidates are recomputed each visit; this suppresses pairs the operator
 * has rejected. Stored as an unordered pair (low_id < high_id) so a dismissal
 * is direction-agnostic.
 */
export const entityMergeDismissals = pgTable(
  'entity_merge_dismissals',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    lowId: uuid('low_id').notNull(),
    highId: uuid('high_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('entity_merge_dismissals_pair_uq').on(t.ownerId, t.lowId, t.highId)],
);

export type EntityMergeDismissal = typeof entityMergeDismissals.$inferSelect;
export type NewEntityMergeDismissal = typeof entityMergeDismissals.$inferInsert;
