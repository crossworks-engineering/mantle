import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Profiles mirror `auth.users.id`. We don't redefine auth.users — Supabase
 * owns it. This is just where we hang display preferences, etc.
 */
export const profiles = pgTable('profiles', {
  // FK to auth.users.id. Drizzle can't see that schema, so we leave it as a
  // plain uuid; the actual FK constraint is added in the SQL migration.
  userId: uuid('user_id').primaryKey(),
  displayName: text('display_name'),
  preferences: jsonb('preferences').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
