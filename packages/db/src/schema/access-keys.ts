import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Inbound API keys (migration 0232, plan page 1e62e204). An admin makes a
 * named key that acts as ONE login (an admin, a member or a client) and can
 * only narrow that login's rights: `access` (read or read_write) and
 * `areas` (null = all). A key works as a Bearer on /api/v1/* and /api/mcp,
 * nowhere else.
 *
 * Only the SHA-256 of the secret is kept. `key_prefix` is the public part of
 * the secret (`mtlk_<prefix>_<secret>`): the lookup key and what the UI
 * shows. `session_epoch` and `login_role` are the login's at mint: a sign
 * out everywhere, a password change, a disable or a role change ends the
 * key. The FKs into `auth.users` are declared in the SQL migration (Drizzle
 * manages public.* only; see schema/auth-users.ts).
 */
export const accessKeys = pgTable(
  'access_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    loginId: uuid('login_id').notNull(),
    loginRole: text('login_role').notNull(),
    sessionEpoch: integer('session_epoch').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    access: text('access').notNull(),
    areas: text('areas').array(),
    riskyTools: text('risky_tools')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [
    uniqueIndex('access_keys_prefix_uq').on(t.keyPrefix),
    uniqueIndex('access_keys_hash_uq').on(t.keyHash),
    index('access_keys_login_idx').on(t.loginId),
  ],
);

export type AccessKey = typeof accessKeys.$inferSelect;
