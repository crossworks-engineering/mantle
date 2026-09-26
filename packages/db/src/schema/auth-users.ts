import { boolean, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `auth.users` lives outside the public schema. Historically owned by Supabase
 * GoTrue; in the lean stack we manage it ourselves.
 *
 * Since 0111 the table holds LOGINS into the one brain, not tenants: the
 * ANCHOR row (`is_owner = true`, unique, undeletable) is the account all
 * content is keyed to. Since 0162 a login is an admin (a co-owner identity
 * for the audit trail) or a member (refused by every admin gate; reaches only
 * the member routes, which read at the team level through RLS).
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
  displayName: text('display_name'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  /** 'admin' | 'member' (0162). Read from this row on every request, never
   *  from a token. The anchor is always admin (CHECK). */
  role: text('role').$type<LoginRole>().notNull().default('admin'),
  /** The team contact a member login belongs to (FK to nodes, SET NULL). */
  contactId: uuid('contact_id'),
  /** Set = the login cannot sign in, refresh, or use a session it holds. */
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

export const LOGIN_ROLES = ['admin', 'member'] as const;
export type LoginRole = (typeof LOGIN_ROLES)[number];

export type AuthUser = typeof authUsers.$inferSelect;
