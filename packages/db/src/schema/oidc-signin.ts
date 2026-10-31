import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Company sign-in (OIDC, migration 0349, docs/oidc-sign-in.md).
 *
 * `oidc_signin_links`: which company account signs in as which login. The
 * key is the provider's issuer plus its subject, never an email: an email
 * can change, and matching on one lets a person take over an account. A
 * login links itself, in its own session (server/web lib/oidc); company
 * sign-in never makes a login. `tid` and `oid` keep two claims some
 * providers tie the subject to (a tenant and an object id), for the admin
 * and a later SCIM step; nothing matches on them. A link goes with its
 * login.
 *
 * `oidc_login_state`: per login, what the company sign-in offer and rules
 * need: `outside` (an admin marked the login an outside person, who keeps a
 * password in required mode) and `offer_dismissed_until` (the login hid the
 * "link now" offer). No row reads as not outside and never dismissed.
 *
 * `login_id` FKs into auth.users in the SQL migration (Drizzle only manages
 * public.*; see schema/auth-users.ts).
 */
export const oidcSigninLinks = pgTable(
  'oidc_signin_links',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    loginId: uuid('login_id').notNull(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    tid: text('tid'),
    oid: text('oid'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('oidc_signin_links_issuer_subject_key').on(t.issuer, t.subject),
    uniqueIndex('oidc_signin_links_login_issuer_key').on(t.loginId, t.issuer),
    index('oidc_signin_links_login_idx').on(t.loginId),
  ],
);

export const oidcLoginState = pgTable('oidc_login_state', {
  loginId: uuid('login_id').primaryKey(),
  outside: boolean('outside').notNull().default(false),
  offerDismissedUntil: timestamp('offer_dismissed_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** One row: the mode the last boot with company sign-in on applied
 *  (server/web lib/oidc/boot.ts), so old sessions end only on a real switch
 *  into required. */
export const oidcModeState = pgTable('oidc_mode_state', {
  id: boolean('id').primaryKey().default(true),
  mode: text('mode').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
});

/** What a one-time code is for (migration 0350). */
export type OidcHandoffPurpose = 'signin' | 'link' | 'fresh';

/** The provider account a link code carries until the client spends it. */
export type OidcHandoffIdentity = {
  issuer: string;
  subject: string;
  tid: string | null;
  oid: string | null;
  display: string | null;
};

/**
 * A one-time code the callback hands to the client that started a flow
 * (migration 0350, docs/oidc-sign-in.md). Keyed on the code's sha256, never
 * the code. `challenge`: the client's S256 PKCE challenge, or the MCP consent
 * page's `consent:` binding. `identity`: the account of a link, made when the
 * code is spent. `held`: a link that started on a held ticket, so spending it also
 * signs the login in. `login_id` FKs into auth.users in the SQL migration.
 */
export const oidcHandoffCodes = pgTable(
  'oidc_handoff_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    purpose: text('purpose').$type<OidcHandoffPurpose>().notNull(),
    loginId: uuid('login_id').notNull(),
    epoch: integer('epoch').notNull(),
    challenge: text('challenge').notNull(),
    identity: jsonb('identity').$type<OidcHandoffIdentity>(),
    held: boolean('held').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('oidc_handoff_codes_expires_idx').on(t.expiresAt)],
);

export type OidcSigninLink = typeof oidcSigninLinks.$inferSelect;
export type OidcLoginState = typeof oidcLoginState.$inferSelect;
