import { sql } from 'drizzle-orm';
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { traces } from './traces';

export const pendingToolStatus = pgEnum('pending_tool_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
]);

/**
 * Operator-approved tool calls. When a tool with requires_confirm=true
 * is requested mid-turn, the loop persists a row here instead of
 * dispatching; the operator approves/rejects via the /pending UI or
 * the MCP tools.
 */
export const pendingToolCalls = pgTable(
  'pending_tool_calls',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    toolSlug: text('tool_slug').notNull(),
    args: jsonb('args')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    traceId: uuid('trace_id').references(() => traces.id, { onDelete: 'set null' }),
    status: pendingToolStatus('status').default('pending').notNull(),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    error: text('error'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('pending_tool_calls_owner_status_idx').on(t.ownerId, t.status),
    index('pending_tool_calls_owner_created_idx').on(t.ownerId, t.createdAt),
  ],
);

export type PendingToolCall = typeof pendingToolCalls.$inferSelect;
export type NewPendingToolCall = typeof pendingToolCalls.$inferInsert;
