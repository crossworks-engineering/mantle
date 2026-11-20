import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The answer cache (migration 0392; docs/provider-http.md, "Kept answers"):
 * one paid AI answer of queue work a row, keyed by sha256 of what was asked
 * (the kind, the provider and model, the prompt, the input). Written and read
 * on the system pool only (answer-cache.ts).
 */
export const aiAnswerCache = pgTable('ai_answer_cache', {
  key: text('key').primaryKey(),
  kind: text('kind').notNull(),
  answer: jsonb('answer').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type AiAnswerCacheRow = typeof aiAnswerCache.$inferSelect;
