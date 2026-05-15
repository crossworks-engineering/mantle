import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Saved query for the inbox sidebar — composable predicates (`account`,
 * `branch`, `tag`, `from`, date range, full-text, has_attachment). The JSON
 * shape is intentionally open; the search helper validates it at query time
 * so adding new predicates is a single-place change.
 */
export interface SavedFilterQuery {
  accountIds?: string[];
  branchPath?: string;
  tags?: string[];
  from?: string;
  to?: string;
  subjectContains?: string;
  hasAttachment?: boolean;
  since?: string; // ISO date
  until?: string;
  q?: string; // full-text
  unread?: boolean;
}

export const savedFilters = pgTable(
  'saved_filters',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    query: jsonb('query').$type<SavedFilterQuery>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('saved_filters_user_idx').on(t.userId)],
);

export type SavedFilter = typeof savedFilters.$inferSelect;
export type NewSavedFilter = typeof savedFilters.$inferInsert;
