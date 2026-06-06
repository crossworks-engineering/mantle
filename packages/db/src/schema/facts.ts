import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { vector } from './_shared';
import { nodes } from './nodes';
import { entities } from './entities';

/**
 * `factual`     — a verifiable claim ("Sarah's passport expires 2030-06-12").
 * `episodic`    — a record of something that happened ("the user said X on date Y").
 * `semantic`    — a stable abstraction ("the user is a teacher").
 * `preference`  — a stable interaction preference ("the user prefers terse replies").
 */
export const factKind = pgEnum('fact_kind', [
  'factual',
  'episodic',
  'semantic',
  'preference',
]);

/**
 * The durable, declarative half of the profile layer. One row per fact;
 * citations point back at the source `nodes` row via source_node_id.
 * Temporal window via valid_from / valid_to means superseded facts stay
 * queryable for audit + history. UPDATE flow: set valid_to on the old row,
 * INSERT a new row with superseded_by pointing at the old.
 *
 * On source-node DELETE (kind-aware, migration 0059): episodic + factual facts
 * are document-specific and hard-delete with the source; semantic + preference
 * facts are durable and kept — the source_node_id FK below is ON DELETE SET
 * NULL, so they survive sourceless.
 */
export const facts = pgTable(
  'facts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    content: text('content').notNull(),
    kind: factKind('kind').notNull(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'set null' }),
    confidence: real('confidence').default(1.0).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    sourceNodeId: uuid('source_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    embedding: vector(768)('embedding'),
    supersededBy: uuid('superseded_by'),
    data: jsonb('data').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    /** True if the source node was edited and this fact should be re-extracted. */
    dirty: boolean('dirty').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('facts_owner_kind_idx').on(t.ownerId, t.kind),
    index('facts_owner_entity_idx').on(t.ownerId, t.entityId),
    index('facts_source_node_idx').on(t.sourceNodeId),
    // ivfflat index on embedding is created in the migration; Drizzle can't emit it.
  ],
);

export type Fact = typeof facts.$inferSelect;
export type NewFact = typeof facts.$inferInsert;
