import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * SCIM user provisioning (migration 0359, docs/scim.md).
 *
 * `scim_users`: the logins a company's identity provider manages, with the
 * provider's own id for the person (`external_id`, its externalId). A row
 * is made when the provider creates the login, or the first time it writes
 * to a login it found by userName. No way in: nothing signs in on it.
 * `scim_disabled_at` is the disable the provider made (see the column).
 *
 * `login_id` FKs into auth.users in the SQL migration (Drizzle only manages
 * public.*; see schema/auth-users.ts).
 */
export const scimUsers = pgTable('scim_users', {
  loginId: uuid('login_id').primaryKey(),
  externalId: text('external_id'),
  /** The login's disabled_at when the provider disabled it: the provider
   *  may enable the login again only while it is still that one. */
  scimDisabledAt: timestamp('scim_disabled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
