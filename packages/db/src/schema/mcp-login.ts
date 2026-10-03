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
 * MCP as a login (migration 0227, plan page e5b854dd). The FKs into
 * `auth.users` are declared in the SQL migration (Drizzle only manages
 * public.*; see schema/auth-users.ts).
 */

/**
 * The admin's per-login switch for a MEMBER or CLIENT login. The login
 * reaches /api/mcp only while `enabled` is on, and gets its draft write
 * tools only while `write_enabled` is on. No row = off.
 */
export const mcpLoginAccess = pgTable('mcp_login_access', {
  loginId: uuid('login_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  writeEnabled: boolean('write_enabled').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A static bearer token bound to one member or client login, for an MCP
 * client that does not do OAuth. Only the SHA-256 is kept. `session_epoch`
 * is the login's epoch at mint: once the login's epoch moves on (sign out
 * everywhere, password change, disable, role change) the token is dead.
 */
export const mcpLoginTokens = pgTable(
  'mcp_login_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    loginId: uuid('login_id').notNull(),
    label: text('label').notNull().default('MCP client'),
    tokenHash: text('token_hash').notNull(),
    sessionEpoch: integer('session_epoch').notNull(),
    createdBy: uuid('created_by'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('mcp_login_tokens_hash_uq').on(t.tokenHash),
    index('mcp_login_tokens_login_idx').on(t.loginId),
  ],
);

export type McpLoginAccess = typeof mcpLoginAccess.$inferSelect;
export type McpLoginToken = typeof mcpLoginTokens.$inferSelect;
