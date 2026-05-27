import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { nodes } from './nodes';

/**
 * Web assistant chat surface. One row per turn (inbound or outbound).
 * One continuous conversation **per (owner, agent)** — each agent has its
 * own forever-thread, no sessions / no thread switcher. The "same mind"
 * is shared (nodes / facts / entities aren't agent-partitioned), but the
 * conversation transcripts are strictly per-agent.
 *
 * Mirror of `telegram_messages` minus the transport-specifics; sharing
 * a shape across surfaces keeps the responder's prompt-building pipeline
 * reusable.
 *
 * `agent_id` is NOT NULL since migration 0049 — the legacy fold-in that
 * matched NULL rows under any assistant-role agent (the "different agents
 * show the same chat with content swapped" bug) is structurally extinct.
 */
export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    direction: text('direction').notNull(), // 'inbound' | 'outbound' (CHECK enforced in SQL)
    text: text('text').notNull(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'set null' }),
    model: text('model'),
    digestNodeId: uuid('digest_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    data: jsonb('data').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('assistant_messages_owner_created_idx').on(t.ownerId, t.createdAt),
    // Drives the per-agent transcript query in recentAssistantMessages.
    index('assistant_messages_owner_agent_created_idx').on(t.ownerId, t.agentId, t.createdAt),
  ],
);

export type AssistantMessage = typeof assistantMessages.$inferSelect;
export type NewAssistantMessage = typeof assistantMessages.$inferInsert;
