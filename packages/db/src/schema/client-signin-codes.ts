import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Client sign-in codes (client logins C2, migration 0188). A client login
 * has no password: it signs in with a one-use code. C2 has admin-issued
 * sign-in links (`kind` 'admin_link', 72 hours); C2b adds emailed codes
 * (`kind` 'email', with `request_id`, `request_ip` (0191) and `attempts`).
 * Only a SHA-256 of a code is stored.
 *
 * `login_id` FKs auth.users ON DELETE CASCADE and `created_by` ON DELETE SET
 * NULL in the SQL. Admin only: no viewer role reads it.
 */
export const clientSigninCodes = pgTable(
  'client_signin_codes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    loginId: uuid('login_id').notNull(),
    kind: text('kind').$type<'admin_link' | 'email'>().notNull(),
    /** SHA-256 hex of the plaintext code. */
    codeHash: text('code_hash').notNull().unique(),
    /** The browser request an emailed code belongs to (the request cookie). */
    requestId: uuid('request_id'),
    /** Where an emailed code was asked from (0191): the send caps count per
     *  email plus address. */
    requestIp: text('request_ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** The admin login that issued it (null for an emailed code). */
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('client_signin_codes_login_idx').on(t.loginId, t.createdAt.desc()),
    index('client_signin_codes_request_idx')
      .on(t.requestId)
      .where(sql`${t.requestId} IS NOT NULL`),
    index('client_signin_codes_kind_created_idx').on(t.kind, t.createdAt),
  ],
);

export type ClientSigninCodeRow = typeof clientSigninCodes.$inferSelect;
