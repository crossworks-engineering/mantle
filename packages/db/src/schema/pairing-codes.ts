import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * One-time pairing codes behind "Sign in on your phone": the web app (signed
 * in) asks `POST /api/auth/pair` for a code and shows it as a QR; the phone
 * scans it and trades it at `POST /api/auth/pair/claim` for the same
 * per-device bearer `mobile-login` mints. See server/web/lib/pair-code.ts.
 *
 * Secrets at rest: only the SHA-256 of the code is stored (the code itself
 * lives in the QR for ~90 s). Single-use: `claimed_at` is set by one
 * conditional UPDATE, so two phones racing the same frame cannot both win.
 * `claimed_device_id` is the minted mobile_tokens row, so the web page can
 * say "phone signed in" and Settings → Logins can revoke it like any device.
 *
 * `user_id` FKs into auth.users in the SQL migration (Drizzle only manages
 * public.*; see schema/auth-users.ts).
 */
export const pairingCodes = pgTable(
  'pairing_codes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** SHA-256 hex of the code handed to the web app. */
    codeHash: text('code_hash').notNull().unique(),
    /** The login (auth.users.id) that asked for the code; the claim signs in as it. */
    userId: uuid('user_id').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** The mobile_tokens.id (jti) minted by the claim; null until claimed. */
    claimedDeviceId: uuid('claimed_device_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('pairing_codes_user_idx').on(t.userId)],
);

export type PairingCode = typeof pairingCodes.$inferSelect;
export type NewPairingCode = typeof pairingCodes.$inferInsert;
