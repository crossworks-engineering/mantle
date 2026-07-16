import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Profiles mirror `auth.users.id` (defined in schema/auth-users.ts). This is
 * where we hang display preferences and other per-user state that doesn't fit
 * on the auth row itself.
 */
export const profiles = pgTable('profiles', {
  // FK to auth.users.id. Declared as raw uuid here; the actual FK constraint
  // lives in the SQL migration since auth.users sits in a different schema.
  userId: uuid('user_id').primaryKey(),
  displayName: text('display_name'),
  preferences: jsonb('preferences')
    .$type<Record<string, unknown>>()
    .default(sql`'{}'::jsonb`)
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
