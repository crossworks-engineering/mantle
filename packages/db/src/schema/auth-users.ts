import { boolean, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `auth.users` lives outside the public schema. Historically owned by Supabase
 * GoTrue; in the lean stack we manage it ourselves.
 *
 * Since 0111 the table holds co-admin LOGINS into the one brain, not tenants:
 * the ANCHOR row (`is_owner = true`, unique, undeletable) is the account all
 * content is keyed to; other rows are identities for the audit trail plus a
 * per-user `read_only` flag. Nothing else is scoped per user.
 *
 * Every public.* table that FKs into here uses the raw `uuid` type with the
 * constraint declared in the SQL migrations (Drizzle can't see cross-schema
 * FK targets when those tables live in different files).
 */
const authSchema = pgSchema('auth');

export const authUsers = authSchema.table('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  isOwner: boolean('is_owner').notNull().default(false),
  readOnly: boolean('read_only').notNull().default(false),
  displayName: text('display_name'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export type AuthUser = typeof authUsers.$inferSelect;
