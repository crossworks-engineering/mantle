import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { emailAccounts } from './emails';

/**
 * Client sign-in codes (client logins C2, migration 0188). A client login
 * has no password: it signs in with a one-use code. C2 has admin-issued
 * sign-in links (`kind` 'admin_link', 72 hours); C2b adds emailed codes
 * (`kind` 'email', with `request_id`, `request_ip` (0191) and `attempts`).
 * Only a hash of a code is stored (SHA-256 for a link; an HMAC keyed from
 * SESSION_SECRET for an emailed code). What became of each code mail is
 * `sent_at` / `send_error` (0193).
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
    /** When the mail server took an emailed code's mail (0193). */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** Why an emailed code's mail failed, short, never the code (0193).
     *  A failed code is revoked too. */
    sendError: text('send_error'),
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

/**
 * Code requests skipped because a send cap was hit (0193): the admin card's
 * "someone is using up codes" count. The reason only, nothing of the email,
 * the address or the login. Reaped by the client-codes-reap sweep.
 */
export const clientSigninCodeSkips = pgTable(
  'client_signin_code_skips',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('client_signin_code_skips_created_idx').on(t.createdAt)],
);

/**
 * The sent-mail folders choosing an account as the client sign-in sender
 * added to its `imap_excluded_folders` (0193): exactly those, so choosing
 * another sender, or none, puts them back. Cascades with the account.
 */
export const clientSigninSenderFolders = pgTable('client_signin_sender_folders', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => emailAccounts.id, { onDelete: 'cascade' }),
  folders: text('folders')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
