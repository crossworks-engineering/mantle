import { sql } from 'drizzle-orm';
import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users';
import { nodes } from './nodes';

/**
 * The lowering guard's marks (client logins C5 audit fixes, migration 0197;
 * packages/tools/src/client-sourced.ts). All admin level: no viewer role
 * reads them, the app writes them as the system.
 */

/**
 * A node a staff turn created after it had read text a client wrote: the
 * copy is client-sourced too (`namesClientSourced`). Set by the tool loop,
 * never by a tool or the model; goes with the node.
 */
export const clientSourcedNodes = pgTable('client_sourced_nodes', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull(),
  /** The tool that created it. */
  via: text('via').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A conversation whose turns read text a client wrote: the next turn of the
 * same conversation starts marked while `tainted_at` (the last such read) is
 * under 24 hours old. One row per conversation.
 */
export const conversationTaints = pgTable(
  'conversation_taints',
  {
    ownerId: uuid('owner_id').notNull(),
    /** `conversationTaintKey` (client-sourced.ts). */
    conversationKey: text('conversation_key').notNull(),
    via: text('via').notNull(),
    taintedAt: timestamp('tainted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.conversationKey] })],
);

/**
 * One row per client request filed (client_request_create): the per-message
 * and daily caps count it, so deleting a request never refunds the quota.
 */
export const clientRequestFilings = pgTable(
  'client_request_filings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    loginId: uuid('login_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    threadMessageId: text('thread_message_id'),
    taskId: uuid('task_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('client_request_filings_login_time_idx').on(t.loginId, t.createdAt),
    index('client_request_filings_message_idx')
      .on(t.threadMessageId)
      .where(sql`${t.threadMessageId} IS NOT NULL`),
  ],
);
