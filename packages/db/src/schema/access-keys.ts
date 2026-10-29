import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Inbound API keys (migration 0232, plan page 1e62e204). A login makes a
 * named key that acts as itself, and it can only narrow that login's rights: `access` (read or read_write) and
 * `areas` (null = all). A key works as a Bearer on /api/v1/* and /api/mcp,
 * nowhere else.
 *
 * Only the SHA-256 of the secret is kept. `key_prefix` is the public part of
 * the secret (`mtlk_<prefix>_<secret>`): the lookup key and what the UI
 * shows. A key acts as its login as it is now: it carries no role of its
 * own (the role it was made under went in workspaces W8a, migration 0272,
 * archive_key_roles). A disable ends it; a plain sign-out leaves it; a
 * password change, "sign out everywhere" and an admin's End sessions revoke
 * every key of the login. The FKs into `auth.users` are declared in the SQL
 * migration (Drizzle manages public.* only; see schema/auth-users.ts).
 */
export const accessKeys = pgTable(
  'access_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    loginId: uuid('login_id').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    /** Unused since workspaces W8a (only a client key carried one). */
    sessionEpoch: integer('session_epoch'),
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
    /** The key works on /api/v1 only, never on /api/mcp (migration 0268):
     *  set on a member's key made before the
     *  per-login MCP switch went, when that login never had MCP. A new key
     *  is made without it. */
    apiOnly: boolean('api_only').notNull().default(false),
  },
  (t) => [
    uniqueIndex('access_keys_prefix_uq').on(t.keyPrefix),
    uniqueIndex('access_keys_hash_uq').on(t.keyHash),
    index('access_keys_login_idx').on(t.loginId),
  ],
);

export type AccessKey = typeof accessKeys.$inferSelect;
