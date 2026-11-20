import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * The answer cache (migration 0392; docs/provider-http.md, "Kept answers"):
 * one paid AI answer of queue work a row, keyed by the node it was paid for
 * and sha256 of what was asked (the kind, the provider and model, the
 * prompt, the input). Cascades when the node is deleted. Written and read on
 * the system pool only (answer-cache.ts).
 */
export const aiAnswerCache = pgTable(
  'ai_answer_cache',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    answer: jsonb('answer').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ name: 'ai_answer_cache_pkey', columns: [t.nodeId, t.key] })],
);

export type AiAnswerCacheRow = typeof aiAnswerCache.$inferSelect;
