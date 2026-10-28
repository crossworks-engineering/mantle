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
} from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users';

/**
 * The MCP call log (Journal v3 J8, migration 0345): one row per MCP
 * tools/call, on every transport and for every login kind (an OAuth
 * connector, an API key, a peer, the stdio server). Learning data, not the
 * security trail: an API key's write still leaves its audit_log row.
 *
 * Written once, by the one MCP gateway (@mantle/mcp-core gated-tools.ts,
 * through @mantle/db mcp-call-log.ts), fire and forget. `args` is the call's
 * arguments with secrets redacted and capped (about 4 KB); `error` the
 * refusal or thrown text (about 1 KB); `item_ids` the ids the arguments and
 * the top-level reply name (at most 50); `result_bytes` the reply's size.
 * No reply body is kept. `session_id` groups a login's calls into work
 * sessions: the session of its last call when that was within 30 minutes,
 * else a new one. `workspace_id` is the workspace the call named or a create
 * landed in, when it has one (a snapshot: no foreign key).
 *
 * Read: a login its own rows, an Admin user every row (the row rule of
 * 0345). Removed after 90 days by the nightly `mcp-calls-reap` sweep.
 */
export const mcpCalls = pgTable(
  'mcp_calls',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    loginId: uuid('login_id').references(() => authUsers.id, { onDelete: 'cascade' }),
    /** How the login connected: oauth, key, peer, stdio. */
    via: text('via').notNull(),
    workspaceId: uuid('workspace_id'),
    sessionId: uuid('session_id').notNull(),
    tool: text('tool').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull(),
    ok: boolean('ok').notNull(),
    error: text('error'),
    durationMs: integer('duration_ms').notNull(),
    itemIds: uuid('item_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    resultBytes: integer('result_bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('mcp_calls_login_created_idx').on(t.loginId, t.createdAt.desc()),
    index('mcp_calls_created_idx').on(t.createdAt),
    index('mcp_calls_session_idx').on(t.sessionId),
  ],
);

export type McpCallRow = typeof mcpCalls.$inferSelect;
