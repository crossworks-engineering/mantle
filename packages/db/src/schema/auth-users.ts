import { boolean, integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  /** 'admin' | 'member' (0162) | 'client' (client logins). Read from this
   *  row on every request, never from a token. The anchor is always admin
   *  (CHECK). Code that branches on it names every role and treats an
   *  unknown value as no login (client logins C0: fail closed). No default
   *  (0190): an insert names the role, so a forgotten one fails instead of
   *  making an admin. */
  role: text('role').$type<LoginRole>().notNull(),
  /** The team contact a member login belongs to (FK to nodes, SET NULL).
   *  At most one login per contact (partial unique index, 0181). */
  contactId: uuid('contact_id'),
  /** Set = the login cannot sign in, refresh, or use a session it holds. */
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  /** Signed into every session cookie and asset token (0181) and compared on
   *  each request: bumping it ends them all (password change, disable, role
   *  change, sign out everywhere). A token without the claim counts as 0. */
  sessionEpoch: integer('session_epoch').notNull().default(0),
});

/** Every role a login can hold. 'client' is typed from Phase C0 so each
 *  branch names it; the database CHECK admits it from Phase C1, and no route
 *  creates one before Phase C2. */
export const LOGIN_ROLES = ['admin', 'member', 'client'] as const;
export type LoginRole = (typeof LOGIN_ROLES)[number];

export type AuthUser = typeof authUsers.$inferSelect;
