import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { vector } from './_shared';

/**
 * Distinct things in the user's world — people, projects, places, events,
 * organisations. The entity row carries the canonical name plus aliases
 * for fuzzy matching. Embeddings are over (name + aliases + a short
 * description in data.summary) so "my wife" can semantically resolve to
 * the Sarah entity.
 */
export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** 'person' | 'project' | 'place' | 'event' | 'org' | etc. Free text — the
     *  agent decides the taxonomy. Convention: lowercase. */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    aliases: text('aliases').array().default(sql`'{}'::text[]`).notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    embedding: vector(768)('embedding'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('entities_owner_kind_idx').on(t.ownerId, t.kind),
    // gin(name gin_trgm_ops) and ivfflat indexes are emitted by the SQL migration.
  ],
);

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
