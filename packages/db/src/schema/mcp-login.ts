import { boolean, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * MCP as a login (migration 0227, plan page e5b854dd). The FKs into
 * `auth.users` are declared in the SQL migration (Drizzle only manages
 * public.*; see schema/auth-users.ts).
 *
 * The static login tokens (mcp_login_tokens) went in workspaces W8a
 * (migration 0272, archived as archive_mcp_login_tokens).
 */

/**
 * The old per-login MCP switch of a member login. Archived and frozen by
 * 0268 (workspaces W7b): every login reaches MCP in its own workspaces. No
 * code reads it to grant anything.
 */
export const mcpLoginAccess = pgTable('mcp_login_access', {
  loginId: uuid('login_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  writeEnabled: boolean('write_enabled').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type McpLoginAccess = typeof mcpLoginAccess.$inferSelect;
