import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tsvector, vector } from './_shared';
import { nodes } from './nodes';

/**
 * Derived per-node retrieval chunks. A long document squeezed into one vector
 * is a weak search primitive; chunking it by section and embedding each piece
 * lets retrieval find the *right part* of a long page / email / file.
 *
 * Fully DERIVED from the source node — the extractor rebuilds these
 * (delete-all-for-node, then re-insert) on every (re)index, so they never
 * accumulate. Never authored directly. Cascades when the node is deleted.
 */
export const contentChunks = pgTable(
  'content_chunks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    /** The section heading in effect at this chunk's start, if any. */
    headingPath: text('heading_path'),
    text: text('text').notNull(),
    embedding: vector(768)('embedding'),
    // Declared so SELECTs can reference it; the GENERATED clause + GIN index
    // live in the SQL migration (0119), same split as nodes.search_tsv.
    searchTsv: tsvector('search_tsv'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('content_chunks_node_idx').on(t.nodeId),
    index('content_chunks_owner_idx').on(t.ownerId),
    // ivfflat on embedding lives in the SQL migration (Drizzle can't emit it).
  ],
);

export type ContentChunk = typeof contentChunks.$inferSelect;
export type NewContentChunk = typeof contentChunks.$inferInsert;
