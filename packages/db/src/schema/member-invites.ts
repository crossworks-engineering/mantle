import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * Member invites (member logins, Phase 6; migration 0174). An admin mints an
 * invite for a person (a contact of the brain, or just an email); the person
 * opens the invite link, sets a password, and becomes a MEMBER login. See
 * packages/content/src/member-invites.ts.
 *
 * Modelled on pairing_codes: only the SHA-256 of the code is stored (the
 * plaintext is shown to the admin once); single use (`redeemed_at` is set
 * once, under a row lock, in the transaction that creates the login);
 * `expires_at` is 72 hours out. `owner_id` is the brain anchor, like
 * contact_team_tokens.
 *
 * One open invite per contact (partial unique index): creating a new invite
 * for a contact revokes the old one first.
 *
 * `created_by` and `redeemed_login_id` FK into auth.users in the SQL
 * migration (ON DELETE SET NULL; Drizzle only manages public.*).
 */
export const memberInvites = pgTable(
  'member_invites',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    contactId: uuid('contact_id').references(() => nodes.id, { onDelete: 'set null' }),
    /** Lower-cased; the email the member login is created with. */
    email: text('email').notNull(),
    displayName: text('display_name'),
    /** SHA-256 hex of the plaintext code (the team-token hash). */
    codeHash: text('code_hash').notNull().unique(),
    /** The admin login that minted it. */
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    /** The member login the redeem created. */
    redeemedLoginId: uuid('redeemed_login_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('member_invites_owner_idx').on(t.ownerId, t.createdAt.desc()),
    uniqueIndex('member_invites_open_contact_idx')
      .on(t.contactId)
      .where(sql`${t.redeemedAt} IS NULL AND ${t.revokedAt} IS NULL`),
  ],
);

export type MemberInvite = typeof memberInvites.$inferSelect;
export type NewMemberInvite = typeof memberInvites.$inferInsert;
