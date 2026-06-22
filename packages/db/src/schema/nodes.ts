import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ltree, tsvector, vector } from './_shared';

/**
 * The tree of everything. Every storable thing in Mantle is a node; specialised
 * tables (emails, secrets, …) hang off `node_id`. `path` is materialised so we
 * can climb instantly with ltree's `<@` / `@>` operators.
 */
export const nodeType = pgEnum('node_type', [
  'branch',
  'email',
  'email_thread',
  'file',
  'note',
  'sermon',
  'contact',
  'secret',
  'task',
  'event',
  'printer_project',
  'telegram_message',
  'page',
  'table',
  'mantle_peer',
  'documentation',
  'lifelog',
  'location',
  'app',
]);

export const nodes = pgTable(
  'nodes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(), // FK to auth.users.id, enforced in SQL migration.
    parentId: uuid('parent_id'), // self-FK, enforced in SQL migration.
    type: nodeType('type').notNull(),
    title: text('title').notNull(),
    slug: text('slug'),
    data: jsonb('data').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    path: ltree('path').notNull(),
    tags: text('tags').array().default(sql`'{}'::text[]`).notNull(),
    embedding: vector(768)('embedding'),
    // `search_tsv` is a GENERATED ALWAYS column — declared here as a regular
    // tsvector so SELECTs can read it; the actual `GENERATED` clause is in
    // the SQL migration since Drizzle doesn't model that yet.
    searchTsv: tsvector('search_tsv'),
    // Retrieval weight, 0..1 (1 = full personal value). Default 1.0 leaves every
    // node untouched; the email pipeline lowers it for bulk/marketing mail
    // (mapped from emails.delivery_kind) so newsletters can't crowd out real
    // content at retrieval. A down-weight, never a filter. See migration 0073
    // + docs/recall-eval.md. Applied as ORDER BY (dist + λ·(1-salience)).
    salience: real('salience').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('nodes_owner_idx').on(t.ownerId),
    index('nodes_parent_idx').on(t.parentId),
    index('nodes_type_idx').on(t.type),
    // Slug uniqueness applies to NON-branch nodes only. Folders (branches)
    // rely on path-uniqueness below — two folders under different parents may
    // share a name (e.g. each upload surface's dated `…/YYYY-MM-DD`). See
    // migration 0032.
    uniqueIndex('nodes_owner_slug_uq')
      .on(t.ownerId, t.slug)
      .where(sql`${t.slug} is not null and ${t.type} <> 'branch'`),
    // One branch per (owner, path). Emails and files legitimately share
    // paths so this is a partial index gated on type='branch'.
    uniqueIndex('nodes_branch_owner_path_uq')
      .on(t.ownerId, t.path)
      .where(sql`${t.type} = 'branch'`),
    // GiST on path, GIN on tags + tsvector, and the HNSW index on embedding
    // (partial, WHERE embedding IS NOT NULL — migration 0057) live in the SQL
    // migrations (Drizzle can't emit those operator classes yet).
  ],
);

export type Node = typeof nodes.$inferSelect;
export type NewNode = typeof nodes.$inferInsert;
