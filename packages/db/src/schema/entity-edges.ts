import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Typed, directional relationships between any combination of entities,
 * facts, and nodes. No FK on source/target_id because the target can be
 * one of three tables (polymorphic); the source_kind + target_kind columns
 * tell the application which table to join. Integrity is application-level.
 *
 * Temporal: valid_from / valid_to let an edge encode "was true between
 * these dates" — e.g. employment relations, residency, project membership.
 * Currently-true edges have valid_to IS NULL.
 */
export const entityEdges = pgTable(
  'entity_edges',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    /** 'entity' | 'fact' | 'node' */
    sourceKind: text('source_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    targetKind: text('target_kind').notNull(),
    /** 'married_to' | 'works_at' | 'mentioned_in' | 'parent_of' | … */
    relation: text('relation').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('entity_edges_source_idx').on(t.sourceId, t.relation),
    index('entity_edges_target_idx').on(t.targetId, t.relation),
  ],
);

export type EntityEdge = typeof entityEdges.$inferSelect;
export type NewEntityEdge = typeof entityEdges.$inferInsert;
