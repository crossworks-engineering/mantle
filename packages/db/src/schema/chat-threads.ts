import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { nodes } from './nodes';

export type ChatThreadStatus = 'open' | 'archived';

/**
 * Chat archive threads (migration 0231, docs/conversation.md §6c). One row per
 * thread of an agent's chat: a TIME RANGE over that agent's
 * `assistant_messages`, not a copy and not a column on the messages. A turn
 * belongs to the thread whose `[started_at, archived_at)` holds its
 * `created_at`; the open thread has no end.
 *
 * "New chat" archives the open range and opens a new one. The history window,
 * the digests and history recall read only the open range, so a fresh chat
 * starts clean; search, `find_window` and `replay_window` still reach the
 * archived turns. An agent that was never archived has no row at all, which
 * means "no lower bound", exactly the forever-thread it had before.
 *
 * `summary_node_id` is the one note the archive action writes (title, summary,
 * embedding; `data.kind = 'chat_archive'`). It is retrievable by relevance and
 * never extracted (no facts from the brain's own answers).
 *
 * `seed_thread_id` is "Continue from this": the open thread starts with that
 * archived thread's summary in its context, not its raw turns.
 *
 * Member and client threads (team_messages, per login) are a later phase.
 */
export const chatThreads = pgTable(
  'chat_threads',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    status: text('status').$type<ChatThreadStatus>().notNull(), // CHECK in SQL
    title: text('title'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    turnCount: integer('turn_count').default(0).notNull(),
    summaryNodeId: uuid('summary_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    seedThreadId: uuid('seed_thread_id').references((): AnyPgColumn => chatThreads.id, {
      onDelete: 'set null',
    }),
    /** The login that pressed "New chat" (auth.users id; no FK, cross-schema). */
    archivedBy: uuid('archived_by'),
    data: jsonb('data')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('chat_threads_owner_agent_started_idx').on(t.ownerId, t.agentId, t.startedAt),
    // At most one open thread per agent chat.
    uniqueIndex('chat_threads_one_open_uq')
      .on(t.ownerId, t.agentId)
      .where(sql`status = 'open'`),
  ],
);

export type ChatThread = typeof chatThreads.$inferSelect;
export type NewChatThread = typeof chatThreads.$inferInsert;
