import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Per-device bearer tokens for the mobile companion app.
 *
 * The token handed to the device is an HMAC-signed string (same scheme as the
 * session cookie, see apps/web/lib/auth.ts) whose payload embeds this row's
 * `id` as the `jti`. The signature lets the Edge middleware accept the token
 * statelessly; this row is what makes it *revocable*: clearing it (or setting
 * `revoked_at`) makes the next request from that device fail in
 * `getSessionUser()`.
 *
 * Single-user app, so there's no scoping beyond `user_id` — every token belongs
 * to the one owner. One row per paired device; revoke per device.
 *
 * The `user_id` FK into `auth.users` is declared in the SQL migration (Drizzle
 * only manages public.*; see schema/auth-users.ts).
 */
export const mobileTokens = pgTable(
  'mobile_tokens',
  {
    /** Token id == the `jti` embedded in the signed token. */
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id').notNull(),
    /** Human label for the device list, e.g. "Jason's iPhone". */
    label: text('label').notNull().default('Mobile device'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Set when the device is unpaired / token revoked; null while active. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('mobile_tokens_user_idx').on(t.userId)],
);

export type MobileToken = typeof mobileTokens.$inferSelect;
export type NewMobileToken = typeof mobileTokens.$inferInsert;
