import { index, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { halfvec } from './_shared';
import { contentChunks } from './content-chunks';
import { nodes } from './nodes';

/**
 * Passage windows: extra vectors INSIDE a retrieval chunk. A chunk is about
 * 1.6k chars; when a question asks about one sentence of it, the chunk's one
 * vector carries that sentence weakly. Each chunk is cut into sentence
 * windows of about 800 chars and each window gets its own vector; a search
 * that matches a window returns the window's chunk, so what reaches a model
 * is the same chunk text as before (docs/recall-eval.md, "Passage windows").
 *
 * Optional per brain (`embedding_config.chunk_windows`, default off). Fully
 * DERIVED from the chunk: no text is stored (the chunk holds it), the rows
 * cascade with the chunk, and the extractor rebuilds them with the chunks.
 * halfvec: the windows index is about 2.6 vectors per chunk, and half
 * precision ranked the measured set exactly as full precision did.
 */
export const contentChunkWindows = pgTable(
  'content_chunk_windows',
  {
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => contentChunks.id, { onDelete: 'cascade' }),
    /** Window number inside the chunk, from 0. */
    j: integer('j').notNull(),
    ownerId: uuid('owner_id').notNull(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    embedding: halfvec(768)('embedding').notNull(),
    // No access copy: the workspace role reads a window when it reads its
    // node (migration 0249).
  },
  (t) => [
    primaryKey({ columns: [t.chunkId, t.j] }),
    index('content_chunk_windows_owner_idx').on(t.ownerId),
    index('content_chunk_windows_node_idx').on(t.nodeId),
    // The HNSW index (halfvec_cosine_ops) lives in the SQL migration (0229).
  ],
);

export type ContentChunkWindow = typeof contentChunkWindows.$inferSelect;
