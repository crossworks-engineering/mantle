import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { vector } from './_shared';

/**
 * Cache for embedding model outputs. Keyed by sha256(model || ':' || text).
 * Embeddings are deterministic for a given (model, text), so this is a pure
 * content-addressed cache — no eviction, no invalidation needed unless the
 * upstream model is replaced (in which case the key prefix changes too).
 */
export const embeddingCache = pgTable('embedding_cache', {
  contentHash: text('content_hash').primaryKey(),
  embedding: vector(768)('embedding').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type EmbeddingCacheRow = typeof embeddingCache.$inferSelect;
